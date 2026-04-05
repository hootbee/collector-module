import { createApp } from '../main';
import { parseCsvBuffer } from '../common/csv';
import { DiscoveryService } from '../discovery/discovery.service';
import { DomainRecommendationService } from '../domain-recommendation/domain-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

async function waitForJob(discoveryService: DiscoveryService, jobId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = discoveryService.getStatus(jobId);
    if (status.status === 'failed') {
      throw new Error(`Discovery job ${jobId} failed.`);
    }
    if (status.status === 'completed') {
      return discoveryService.getResults(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Discovery job ${jobId} did not complete in time.`);
}

async function main() {
  const app = await createApp();
  await app.init();

  const storeService = app.get(StoreService);
  const profilingService = app.get(ProfilingService);
  const recommendationService = app.get(DomainRecommendationService);
  const discoveryService = app.get(DiscoveryService);

  try {
    const csv = [
      'patient_id,visit_date,heart_rate,alt_u_l,adverse_event_flag',
      'P001,2025-01-01,75,23,no',
      'P002,2025-01-02,92,51,yes',
      'P003,2025-01-03,88,47,no',
      'P004,2025-01-04,65,19,no',
      'P005,2025-01-05,97,62,yes',
    ].join('\n');
    const rawBuffer = Buffer.from(csv, 'utf-8');
    const parsed = parseCsvBuffer(rawBuffer);

    const session = storeService.createSession();
    const dataset = storeService.createDataset({
      sessionId: session.id,
      fileName: 'smoke.csv',
      rawBuffer,
      rows: parsed.rows,
      columns: parsed.columns,
      targetColumns: ['adverse_event_flag'],
      taskType: 'classification',
      description: 'Small clinical visit table for adverse event prediction.',
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
          rowCount: analysis.rowCount,
          metadataCandidates: analysis.metadataCandidates,
          featureColumns: analysis.featureColumns,
          topDomains: recommendation.recommendedDomains.slice(0, 3).map((item) => item.id),
          knowledgeCount: results.knowledgeItems.length,
          datasetCount: results.datasetItems.length,
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
