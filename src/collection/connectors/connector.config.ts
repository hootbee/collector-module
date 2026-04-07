import type { DiscoverySourceType } from '../types/collection-hit';

export const rankingWeights = {
  domainMatch: 8.5,
  crossDomainPenalty: 7.5,
  taskMatch: 6.5,
  taskMismatchPenalty: 3,
  modalityMatch: 5.5,
  modalityMismatchPenalty: 2.5,
  keywordTagOverlap: 4,
  keywordTextOverlap: 1.8,
  descriptionOverlap: 1.8,
  labelOverlap: 2.5,
  exactModalityBonus: 3,
  textAgainstTablePenalty: 5.5,
  weakOverlapPenalty: 6.5,
  negativePenalty: 3.5,
  textFirstBonus: 3.5,
  textFirstPenalty: 6.5,
  forecastOverlap: 2.2,
  anomalyInForecastPenalty: 4.5,
  sourceReliabilityMultiplier: 6,
  sourcePriorityMultiplier: 2,
  mustIncludeBonus: 2.75,
  mustAvoidPenalty: 5,
  llmRelevanceMultiplier: 4,
} as const;

export const connectorSourceMetadata: Record<
  string,
  {
    sourceType: DiscoverySourceType;
    priority: number;
    reliability: number;
    datasetLimit: number;
    knowledgeLimit: number;
  }
> = {
  'seed-catalog': {
    sourceType: 'seed',
    priority: 0.7,
    reliability: 0.7,
    datasetLimit: 4,
    knowledgeLimit: 4,
  },
  huggingface: {
    sourceType: 'primary',
    priority: 1,
    reliability: 0.95,
    datasetLimit: 5,
    knowledgeLimit: 0,
  },
  openml: {
    sourceType: 'primary',
    priority: 0.92,
    reliability: 0.92,
    datasetLimit: 3,
    knowledgeLimit: 0,
  },
  crossref: {
    sourceType: 'primary',
    priority: 1,
    reliability: 0.96,
    datasetLimit: 0,
    knowledgeLimit: 6,
  },
  serpapi: {
    sourceType: 'meta',
    priority: 0.82,
    reliability: 0.78,
    datasetLimit: 0,
    knowledgeLimit: 4,
  },
  uci: {
    sourceType: 'support',
    priority: 0.68,
    reliability: 0.65,
    datasetLimit: 2,
    knowledgeLimit: 0,
  },
  kaggle: {
    sourceType: 'support',
    priority: 0.72,
    reliability: 0.7,
    datasetLimit: 5,
    knowledgeLimit: 0,
  },
  unknown: {
    sourceType: 'support',
    priority: 0.5,
    reliability: 0.5,
    datasetLimit: 2,
    knowledgeLimit: 2,
  },
};

export function connectorMetadata(connector: string) {
  return connectorSourceMetadata[connector] ?? connectorSourceMetadata.unknown;
}
