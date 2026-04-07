import { createApp } from '../main';
import type { CollectionSourceId } from '../common/contracts';
import { CollectionService } from '../collection/collection.service';

async function waitForCollectionJob(collectionService: CollectionService, jobId: string) {
  const waitAttempts = Number(process.env.COLLECTION_SMOKE_WAIT_ATTEMPTS ?? 80);
  const waitMs = Number(process.env.COLLECTION_SMOKE_WAIT_MS ?? 500);

  for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
    const status = collectionService.getStatus(jobId);
    if (status.status === 'failed') {
      throw new Error(`Collection job ${jobId} failed: ${status.error ?? 'unknown error'}`);
    }
    if (status.status === 'completed') {
      return collectionService.getResults(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new Error(`Collection job ${jobId} did not complete in time.`);
}

function loadSources(): CollectionSourceId[] {
  const raw = process.env.COLLECTION_SMOKE_SOURCES?.trim();
  if (!raw) {
    return ['seed-catalog'];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as CollectionSourceId[];
}

async function main() {
  const app = await createApp();
  await app.init();

  const collectionService = app.get(CollectionService);

  try {
    const query = process.env.COLLECTION_SMOKE_QUERY?.trim() || 'ai generated text detection dataset';
    const kind = (process.env.COLLECTION_SMOKE_KIND?.trim() || 'both') as 'dataset' | 'knowledge' | 'both';
    const sources = loadSources();
    const mustInclude = (process.env.COLLECTION_SMOKE_MUST_INCLUDE?.trim() || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const mustAvoid = (process.env.COLLECTION_SMOKE_MUST_AVOID?.trim() || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const job = await collectionService.createJob({
      query,
      kind,
      requestedSources: sources,
      mustInclude,
      mustAvoid,
    });
    const results = await waitForCollectionJob(collectionService, job.jobId);

    console.log(
      JSON.stringify(
        {
          jobId: job.jobId,
          query: results.query,
          kind: results.kind,
          requestedSources: results.requestedSources,
          datasetQueries: results.datasetQueries,
          knowledgeQueries: results.knowledgeQueries,
          mustInclude: results.mustInclude,
          mustAvoid: results.mustAvoid,
          llmPlanRaw: results.llmPlanRaw,
          llmPlan: results.llmPlan,
          connectorStatuses: results.connectorStatuses,
          rawKnowledgeCount: results.rawKnowledgeHits.length,
          rawDatasetCount: results.rawDatasetHits.length,
          knowledgeCount: results.knowledgeItems.length,
          datasetCount: results.datasetItems.length,
          knowledgeItems: results.knowledgeItems.slice(0, 5).map((item) => ({
            id: item.id,
            source: item.source,
            title: item.title,
          })),
          datasetItems: results.datasetItems.slice(0, 5).map((item) => ({
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
