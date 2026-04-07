import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createApp } from '../main';
import { parseCsvBuffer } from '../common/csv';
import { DiscoveryService } from '../discovery/discovery.service';
import { DomainRecommendationService } from '../domain-recommendation/domain-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

async function waitForJob(discoveryService: DiscoveryService, jobId: string) {
  const waitAttempts = Number(process.env.SMOKE_WAIT_ATTEMPTS ?? 40);
  const waitMs = Number(process.env.SMOKE_WAIT_MS ?? 250);

  for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
    const status = discoveryService.getStatus(jobId);
    if (status.status === 'failed') {
      throw new Error(`Discovery job ${jobId} failed.`);
    }
    if (status.status === 'completed') {
      return discoveryService.getResults(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new Error(`Discovery job ${jobId} did not complete in time.`);
}

async function loadSmokeDataset() {
  const datasetPath = process.env.SMOKE_DATASET_PATH?.trim();
  if (!datasetPath) {
    const csv = [
      'patient_id,visit_date,heart_rate,alt_u_l,adverse_event_flag',
      'P001,2025-01-01,75,23,no',
      'P002,2025-01-02,92,51,yes',
      'P003,2025-01-03,88,47,no',
      'P004,2025-01-04,65,19,no',
      'P005,2025-01-05,97,62,yes',
    ].join('\n');

    return {
      rawBuffer: Buffer.from(csv, 'utf-8'),
      fileName: 'smoke.csv',
      targetColumns: ['adverse_event_flag'],
      taskType: 'classification' as const,
      description: 'Small clinical visit table for adverse event prediction.',
    };
  }

  const rawBuffer = await readFile(datasetPath);
  const taskType = (process.env.SMOKE_TASK_TYPE?.trim() || 'classification') as
    | 'classification'
    | 'anomaly'
    | 'regression';
  const targetColumns = (process.env.SMOKE_TARGET_COLUMNS?.trim() || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    rawBuffer,
    fileName: process.env.SMOKE_FILE_NAME?.trim() || basename(datasetPath),
    targetColumns,
    taskType,
    description:
      process.env.SMOKE_DESCRIPTION?.trim() ||
      `Smoke test dataset loaded from ${datasetPath}`,
  };
}

async function main() {
  const app = await createApp();
  await app.init();

  const storeService = app.get(StoreService);
  const profilingService = app.get(ProfilingService);
  const recommendationService = app.get(DomainRecommendationService);
  const discoveryService = app.get(DiscoveryService);

  try {
    const smokeDataset = await loadSmokeDataset();
    const rawBuffer = smokeDataset.rawBuffer;
    const parsed = parseCsvBuffer(rawBuffer);

    const session = storeService.createSession();
    const dataset = storeService.createDataset({
      sessionId: session.id,
      fileName: smokeDataset.fileName,
      rawBuffer,
      rows: parsed.rows,
      columns: parsed.columns,
      targetColumns: smokeDataset.targetColumns,
      taskType: smokeDataset.taskType,
      description: smokeDataset.description,
    });

    const analysis = storeService.setDatasetAnalysis(dataset.id, profilingService.analyzeDataset(dataset));
    const recommendation = storeService.setDatasetRecommendation(
      dataset.id,
      await recommendationService.recommendDataset({
        dataset,
        metadataColumns: analysis.metadataCandidates,
      }),
    );

    const job = await discoveryService.createJob({
      datasetId: dataset.id,
      metadataColumns: analysis.metadataCandidates,
      selectedDomains: recommendation.recommendedDomains.slice(0, 2).map((item) => item.id),
    });

    const results = await waitForJob(discoveryService, job.jobId);

    console.log(
      JSON.stringify(
        {
          datasetId: dataset.id,
          fileName: dataset.fileName,
          rowCount: analysis.rowCount,
          metadataCandidates: analysis.metadataCandidates,
          featureColumns: analysis.featureColumns,
          topDomains: recommendation.recommendedDomains.slice(0, 3).map((item) => item.id),
          knowledgeCount: results.knowledgeItems.length,
          datasetCount: results.datasetItems.length,
          knowledgeItems: results.knowledgeItems.map((item) => ({
            id: item.id,
            source: item.source,
            title: item.title,
          })),
          datasetItems: results.datasetItems.map((item) => ({
            id: item.id,
            provider: item.provider,
            name: item.name,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

void main();
