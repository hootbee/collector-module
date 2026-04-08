import type {
  CollectionExtractionMethod,
  CollectionGenericHtmlLlmPlan,
  CollectionLayer,
  CollectionSourceClassification,
  CollectionSourceConfidence,
  CollectionSourceId,
  DatasetCatalogEntry,
  KnowledgeCatalogEntry,
  ModalitySignal,
  TaskSignal,
} from '../../common/contracts';

export type DiscoveryHitKind = 'knowledge' | 'dataset';
export type DiscoverySourceType = 'primary' | 'support' | 'meta' | 'seed';

export type SearchHitBase = {
  id: string;
  kind: DiscoveryHitKind;
  connector: string;
  sourceType: DiscoverySourceType;
  layer?: CollectionLayer;
  sourcePriority: number;
  sourceReliability: number;
  sourceClassification?: CollectionSourceClassification;
  sourceConfidence?: CollectionSourceConfidence;
  detectedHost?: string;
  routedConnector?: string;
  metadataCompleteness?: number;
  directDownloadAvailable?: boolean;
  extractionMethod?: CollectionExtractionMethod;
  extractionReliability?: number;
  title: string;
  text: string;
  tags: string[];
  domainIds: string[];
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  modality: 'text' | 'table' | 'hybrid';
  negativeTags: string[];
  matchedQueries: string[];
  matchedTerms: string[];
  llmRelevance?: number;
};

export type FetchedDocument = {
  sourceHitId: string;
  url: string;
  finalUrl?: string;
  extractedText: string;
  metadata?: Record<string, unknown>;
  extractionMethod: CollectionExtractionMethod;
  retrievedAt: string;
  llmPlannerUsed?: boolean;
  llmPlanRawPreview?: string | null;
  llmPlan?: CollectionGenericHtmlLlmPlan | null;
};

export type RoutedHit = {
  sourceHitId: string;
  kind: DiscoveryHitKind;
  connector: CollectionSourceId;
  layer: CollectionLayer;
  url?: string;
  detectedHost?: string;
  sourceClassification: CollectionSourceClassification;
  sourceConfidence: CollectionSourceConfidence;
  routedConnector?: CollectionSourceId;
  rerouted: boolean;
};

export type DiscoveryHitBase = SearchHitBase;

export type KnowledgeDiscoveryHit = SearchHitBase & {
  kind: 'knowledge';
  entry: KnowledgeCatalogEntry;
};

export type DatasetDiscoveryHit = SearchHitBase & {
  kind: 'dataset';
  entry: DatasetCatalogEntry;
};

export type NormalizedKnowledgeCandidate = {
  id: string;
  kind: 'knowledge';
  summary: string;
  matchedKeywords: string[];
  matchedReason: string;
  source: string;
  provider?: string;
  modality: 'text' | 'table' | 'hybrid';
  sourceUrl?: string;
  licenseHint?: string;
  llmRelevance?: number;
};

export type NormalizedDatasetCandidate = {
  id: string;
  kind: 'dataset';
  summary: string;
  matchedKeywords: string[];
  matchedReason: string;
  provider: string;
  modality: 'text' | 'table' | 'hybrid';
  sourceUrl?: string;
  licenseHint?: string;
  llmRelevance?: number;
};

export type DiscoverySearchDebug = {
  id: string;
  connector: string;
  matchedQueries: string[];
  matchedTerms: string[];
  status?: 'ok' | 'error';
  count?: number;
  error?: string;
};

export type DiscoverySearchOutcome<T> = {
  hits: T[];
  debug: DiscoverySearchDebug[];
};

export type RankedDiscoveryHit<T> = {
  hit: T;
  score: number;
  scoreBreakdown?: Record<string, number>;
  matchedKeywords: string[];
  matchedReason: string;
  filteredOutReason: string | null;
};

export type DiscoveryRankingDebug = {
  id: string;
  score: number;
  scoreBreakdown?: Record<string, number>;
  matchedKeywords: string[];
  matchedReason: string;
  filteredOutReason: string | null;
};

export type RankedCandidate<T> = RankedDiscoveryHit<T>;

export type DiscoveryRankingOutcome<T> = {
  items: RankedCandidate<T>[];
  debug: DiscoveryRankingDebug[];
};
