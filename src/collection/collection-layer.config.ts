import type {
  CollectionSourceConfidence,
  CollectionSourceId,
} from '../common/contracts';

export const structuredDatasetSources: CollectionSourceId[] = [
  'seed-catalog',
  'huggingface',
  'openml',
  'uci',
  'kaggle',
];

export const structuredKnowledgeSources: CollectionSourceId[] = [
  'seed-catalog',
  'crossref',
];

export const genericDatasetSources: CollectionSourceId[] = ['serpapi'];
export const genericKnowledgeSources: CollectionSourceId[] = ['serpapi'];

const knownHostMappings: Array<{
  hostSuffix: string;
  connector: CollectionSourceId;
  confidence: CollectionSourceConfidence;
}> = [
  { hostSuffix: 'huggingface.co', connector: 'huggingface', confidence: 'high' },
  { hostSuffix: 'kaggle.com', connector: 'kaggle', confidence: 'high' },
  { hostSuffix: 'openml.org', connector: 'openml', confidence: 'high' },
  { hostSuffix: 'archive.ics.uci.edu', connector: 'uci', confidence: 'medium' },
  { hostSuffix: 'doi.org', connector: 'crossref', confidence: 'medium' },
  { hostSuffix: 'crossref.org', connector: 'crossref', confidence: 'high' },
];

export function detectKnownSource(url?: string): {
  detectedHost?: string;
  routedConnector?: CollectionSourceId;
  sourceConfidence: CollectionSourceConfidence;
} {
  if (!url) {
    return {
      sourceConfidence: 'low',
    };
  }

  try {
    const detectedHost = new URL(url).hostname.replace(/^www\./, '');
    const match = knownHostMappings.find((item) => detectedHost === item.hostSuffix || detectedHost.endsWith(`.${item.hostSuffix}`));
    if (!match) {
      return {
        detectedHost,
        sourceConfidence: 'low',
      };
    }
    return {
      detectedHost,
      routedConnector: match.connector,
      sourceConfidence: match.confidence,
    };
  } catch {
    return {
      sourceConfidence: 'low',
    };
  }
}

export function structuredDatasetThreshold(requestedSources: CollectionSourceId[]): number {
  if (requestedSources.includes('seed-catalog')) {
    return 5;
  }
  return 4;
}

export function structuredKnowledgeThreshold(requestedSources: CollectionSourceId[]): number {
  if (requestedSources.includes('crossref')) {
    return 4;
  }
  return 3;
}

export function genericFetchLimit(): number {
  const raw = Number(process.env.COLLECTION_GENERIC_FETCH_LIMIT ?? '12');
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30) : 12;
}
