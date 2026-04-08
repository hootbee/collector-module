import { createApp } from '../main';
import type {
  CollectedDatasetHit,
  CollectedKnowledgeHit,
  CollectionJobResultsResponse,
  CollectionSourceId,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
} from '../common/contracts';
import { CollectionService } from '../collection/collection.service';

function envBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

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

function loadDetailMode(): 'summary' | 'detailed' | 'raw' {
  const raw = process.env.COLLECTION_SMOKE_DETAIL?.trim().toLowerCase();
  if (raw === 'raw') {
    return 'raw';
  }
  if (raw === 'detailed' || raw === 'detail' || raw === 'full') {
    return 'detailed';
  }
  return 'summary';
}

function loadSampleLimit(): number {
  const raw = Number(process.env.COLLECTION_SMOKE_SAMPLE_LIMIT ?? '10');
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30) : 10;
}

function buildRunSettings(input: {
  query: string;
  kind: 'dataset' | 'knowledge' | 'both';
  sources: CollectionSourceId[];
  detailMode: 'summary' | 'detailed' | 'raw';
  sampleLimit: number;
}) {
  return {
    query: input.query,
    kind: input.kind,
    requestedSources: input.sources,
    detailMode: input.detailMode,
    sampleLimit: input.sampleLimit,
    waitPolicy: {
      waitAttempts: Number(process.env.COLLECTION_SMOKE_WAIT_ATTEMPTS ?? 80),
      waitMs: Number(process.env.COLLECTION_SMOKE_WAIT_MS ?? 500),
    },
    llmPlanner: {
      enabled: envBoolean('COLLECTION_LLM_PLANNER_ENABLED', false),
      provider: process.env.COLLECTION_LLM_PROVIDER?.trim() || process.env.LLM_PROVIDER?.trim() || 'rule-based',
      baseUrl:
        process.env.COLLECTION_LLM_BASE_URL?.trim() ||
        process.env.LLM_BASE_URL?.trim() ||
        process.env.OPENAI_BASE_URL?.trim() ||
        null,
      model:
        process.env.COLLECTION_LLM_MODEL?.trim() ||
        process.env.LLM_MODEL?.trim() ||
        process.env.OPENAI_MODEL?.trim() ||
        null,
      apiMode:
        process.env.COLLECTION_LLM_API_MODE?.trim() ||
        process.env.LLM_API_MODE?.trim() ||
        null,
      timeoutMs: Number(
        process.env.COLLECTION_LLM_TIMEOUT_MS ??
          process.env.LLM_TIMEOUT_MS ??
          process.env.OPENAI_TIMEOUT_MS ??
          15000,
      ),
    },
    connectorFlags: {
      'seed-catalog': envBoolean('COLLECTION_ENABLE_SEED_CONNECTOR', envBoolean('DISCOVERY_ENABLE_SEED_CONNECTOR', true)),
      huggingface: envBoolean('COLLECTION_ENABLE_HF_CONNECTOR', envBoolean('DISCOVERY_ENABLE_HF_CONNECTOR', false)),
      openml: envBoolean('COLLECTION_ENABLE_OPENML_CONNECTOR', envBoolean('DISCOVERY_ENABLE_OPENML_CONNECTOR', false)),
      uci: envBoolean('COLLECTION_ENABLE_UCI_CONNECTOR', envBoolean('DISCOVERY_ENABLE_UCI_CONNECTOR', false)),
      kaggle: envBoolean('COLLECTION_ENABLE_KAGGLE_CONNECTOR', envBoolean('DISCOVERY_ENABLE_KAGGLE_CONNECTOR', false)),
      serpapi: envBoolean('COLLECTION_ENABLE_SERPAPI_CONNECTOR', envBoolean('DISCOVERY_ENABLE_SERPAPI_CONNECTOR', false)),
      crossref: envBoolean('COLLECTION_ENABLE_CROSSREF_CONNECTOR', envBoolean('DISCOVERY_ENABLE_CROSSREF_CONNECTOR', false)),
    },
  };
}

function summarizeKnowledgeItem(item: ExternalKnowledgeItem) {
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    layer: item.layer,
    sourceClassification: item.sourceClassification,
    detectedHost: item.detectedHost,
    publisher: item.publisher,
    sourceUrl: item.sourceUrl,
    retrievalHint: item.retrievalHint,
    matchedKeywords: item.matchedKeywords,
    matchedReason: item.matchedReason,
  };
}

function summarizeDatasetItem(item: ExternalDatasetItem) {
  return {
    id: item.id,
    provider: item.provider,
    name: item.name,
    layer: item.layer,
    sourceClassification: item.sourceClassification,
    detectedHost: item.detectedHost,
    providerDetail: item.providerDetail,
    publisher: item.publisher,
    description: item.description,
    rowsHint: item.rowsHint,
    modality: item.modality,
    licenseHint: item.licenseHint,
    sourceUrl: item.sourceUrl,
    retrievalHint: item.retrievalHint,
    matchedKeywords: item.matchedKeywords,
    directDownloadAvailable: item.directDownloadAvailable,
    downloadUrl: item.downloadUrl,
    downloadMethod: item.downloadMethod,
    downloadHint: item.downloadHint,
    downloadReference: item.downloadReference,
    matchedReason: item.matchedReason,
  };
}

function summarizeRawKnowledgeHit(hit: CollectedKnowledgeHit) {
  return {
    id: hit.id,
    connector: hit.connector,
    title: hit.title,
    layer: hit.layer,
    sourceType: hit.sourceType,
    sourceClassification: hit.sourceClassification,
    detectedHost: hit.detectedHost,
    matchedQueries: hit.matchedQueries,
    matchedTerms: hit.matchedTerms,
    sourceUrl: hit.sourceUrl,
    retrievalHint: hit.retrievalHint,
  };
}

function summarizeRawDatasetHit(hit: CollectedDatasetHit) {
  return {
    id: hit.id,
    connector: hit.connector,
    title: hit.title,
    provider: hit.provider,
    layer: hit.layer,
    sourceType: hit.sourceType,
    sourceClassification: hit.sourceClassification,
    detectedHost: hit.detectedHost,
    providerDetail: hit.providerDetail,
    publisher: hit.publisher,
    directDownloadAvailable: hit.directDownloadAvailable,
    matchedQueries: hit.matchedQueries,
    matchedTerms: hit.matchedTerms,
    sourceUrl: hit.sourceUrl,
    retrievalHint: hit.retrievalHint,
    downloadUrl: hit.downloadUrl,
    downloadMethod: hit.downloadMethod,
    downloadHint: hit.downloadHint,
    downloadReference: hit.downloadReference,
  };
}

function buildSummary(
  results: CollectionJobResultsResponse,
  sampleLimit: number,
  runSettings: ReturnType<typeof buildRunSettings>,
) {
  return {
    runSettings,
    jobId: results.jobId,
    query: results.query,
    kind: results.kind,
    requestedSources: results.requestedSources,
    datasetQueries: results.datasetQueries,
    knowledgeQueries: results.knowledgeQueries,
    mustInclude: results.mustInclude,
    mustAvoid: results.mustAvoid,
    llmPlannerUsed: results.llmPlan != null,
    llmPlannerRawCaptured: results.llmPlanRaw != null,
    llmPlanRaw: results.llmPlanRaw,
    llmPlan: results.llmPlan,
    connectorStatuses: results.connectorStatuses,
    routedHitCount: results.routedHits.length,
    fetchedDocumentCount: results.fetchedDocuments.length,
    rawKnowledgeCount: results.rawKnowledgeHits.length,
    rawDatasetCount: results.rawDatasetHits.length,
    knowledgeCount: results.knowledgeItems.length,
    datasetCount: results.datasetItems.length,
    routedHits: results.routedHits.slice(0, sampleLimit),
    knowledgeItems: results.knowledgeItems.slice(0, sampleLimit).map(summarizeKnowledgeItem),
    datasetItems: results.datasetItems.slice(0, sampleLimit).map(summarizeDatasetItem),
  };
}

function buildDetailed(
  results: CollectionJobResultsResponse,
  sampleLimit: number,
  runSettings: ReturnType<typeof buildRunSettings>,
) {
  return {
    ...buildSummary(results, sampleLimit, runSettings),
    fetchedDocuments: results.fetchedDocuments.slice(0, sampleLimit).map((item) => ({
      sourceHitId: item.sourceHitId,
      url: item.url,
      finalUrl: item.finalUrl,
      extractionMethod: item.extractionMethod,
      retrievedAt: item.retrievedAt,
      metadataKeys: Object.keys(item.metadata ?? {}),
      metadata: item.metadata,
      extractedTextPreview: item.extractedText.slice(0, 240),
    })),
    rawKnowledgeHits: results.rawKnowledgeHits.slice(0, sampleLimit).map(summarizeRawKnowledgeHit),
    rawDatasetHits: results.rawDatasetHits.slice(0, sampleLimit).map(summarizeRawDatasetHit),
  };
}

async function main() {
  const app = await createApp();
  await app.init();

  const collectionService = app.get(CollectionService);

  try {
    const query = process.env.COLLECTION_SMOKE_QUERY?.trim() || 'ai generated text detection dataset';
    const kind = (process.env.COLLECTION_SMOKE_KIND?.trim() || 'both') as 'dataset' | 'knowledge' | 'both';
    const sources = loadSources();
    const detailMode = loadDetailMode();
    const sampleLimit = loadSampleLimit();
    const runSettings = buildRunSettings({
      query,
      kind,
      sources,
      detailMode,
      sampleLimit,
    });
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
    const payload =
      detailMode === 'raw'
        ? { runSettings, ...results }
        : detailMode === 'detailed'
          ? buildDetailed(results, sampleLimit, runSettings)
          : buildSummary(results, sampleLimit, runSettings);
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await app.close();
  }
}

void main();
