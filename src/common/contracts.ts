export type TaskType = 'classification' | 'anomaly' | 'regression';
export type DiscoveryJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type CollectionKind = 'dataset' | 'knowledge' | 'both';
export type CollectionSourceId =
  | 'seed-catalog'
  | 'huggingface'
  | 'openml'
  | 'uci'
  | 'kaggle'
  | 'serpapi'
  | 'crossref';
export type TaskSignal =
  | 'classification'
  | 'regression'
  | 'anomaly-detection'
  | 'time-series-forecasting'
  | 'content-authenticity'
  | 'authorship-attribution';
export type ModalitySignal =
  | 'tabular'
  | 'text'
  | 'time-series'
  | 'transaction'
  | 'longitudinal'
  | 'document';

export type ColumnMissingStat = {
  column: string;
  missingCount: number;
  totalRows: number;
  missingRate: number;
};

export type ClassImbalanceValueCount = {
  value: string;
  count: number;
  ratio: number;
};

export type ClassImbalanceStat = {
  column: string;
  valueCounts: ClassImbalanceValueCount[];
  distinctCount: number;
  minorityRatio: number;
  majorityRatio: number;
  imbalanceRatio: number | null;
  isHighlyImbalanced: boolean;
};

export type NumericTargetStat = {
  column: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
};

export type TargetStatSummary<T> = {
  col: string;
  stat: T | null;
};

export type DomainRelevance = 'high' | 'medium' | 'low';

export type DomainDatasetSummary = {
  fileName: string;
  rowCount: number;
  colCount: number;
  taskType: TaskType;
  metaColumns: string[];
  featureColumnCount: number;
  featureColumns?: string[];
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  targetColumns: string[];
  description: string;
};

export type RecommendedDomain = {
  id: string;
  name: string;
  shortDescription: string;
  recommendationReason: string;
  keywords: string[];
  relevance: DomainRelevance;
};

export type DomainEvidenceSummary = {
  extractedKeywords: string[];
  influentialFeatureColumns: string[];
  influentialTargetColumns: string[];
  descriptionSignals: string[];
};

export type ExternalKnowledgeKind = 'guideline' | 'paper' | 'wiki' | 'standard';

export type ExternalKnowledgeItem = {
  id: string;
  title: string;
  source: string;
  summary: string;
  kind: ExternalKnowledgeKind;
  matchedKeywords: string[];
  sourceUrl?: string;
  publisher?: string;
  retrievalHint?: string;
  score?: number;
  matchedReason?: string;
};

export type ExternalDatasetItem = {
  id: string;
  name: string;
  provider: string;
  description: string;
  rowsHint: string;
  modality: string;
  licenseHint: string;
  matchedKeywords: string[];
  sourceUrl?: string;
  providerDetail?: string;
  publisher?: string;
  retrievalHint?: string;
  score?: number;
  matchedReason?: string;
};

export type SelectedExternalResourcesRecord = {
  datasetId: string;
  knowledgeItems: ExternalKnowledgeItem[];
  datasetItems: ExternalDatasetItem[];
  selectionNotes: string;
  updatedAt: string;
};

export type UpdateSelectedExternalResourcesInput = {
  knowledgeItemIds: string[];
  datasetItemIds: string[];
  selectionNotes?: string;
};

export type DatasetAnalysisResponse = {
  sessionId: string;
  datasetId: string;
  fileName: string;
  rowCount: number;
  colCount: number;
  columns: string[];
  targetColumns: string[];
  taskType: TaskType;
  description: string;
  missingStats: ColumnMissingStat[];
  imbalanceSummary: TargetStatSummary<ClassImbalanceStat>[];
  numericSummary: TargetStatSummary<NumericTargetStat>[];
  metadataCandidates: string[];
  featureColumns: string[];
  inferredTextColumns: string[];
  inferredIdColumns: string[];
  inferredTemporalColumns: string[];
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
};

export type DomainRecommendationResponse = {
  sessionId: string;
  datasetId: string;
  datasetSummary: DomainDatasetSummary;
  evidenceSummary: DomainEvidenceSummary;
  primaryDomainId?: string | null;
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  recommendedDomains: RecommendedDomain[];
  expandedKeywords: string[];
  generatedQueries: string[];
};

export type DiscoveryJobStatusResponse = {
  jobId: string;
  datasetId: string;
  status: DiscoveryJobStatus;
  stage: string;
  knowledgeCount: number;
  datasetCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type DiscoveryJobResultsResponse = {
  jobId: string;
  datasetId: string;
  status: DiscoveryJobStatus;
  stage: string;
  generatedQueries: string[];
  expandedKeywords: string[];
  knowledgeItems: ExternalKnowledgeItem[];
  datasetItems: ExternalDatasetItem[];
};

export type CollectionConnectorStatus = {
  connector: CollectionSourceId;
  status: 'ok' | 'error';
  count: number;
  errors: string[];
};

export type CollectionLlmPlan = {
  canonicalIntent: string;
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  mustInclude: string[];
  mustAvoid: string[];
  datasetSourceQueries: Partial<Record<CollectionSourceId, string[]>>;
  knowledgeSourceQueries: Partial<Record<CollectionSourceId, string[]>>;
  notes: string[];
};

export type CollectedKnowledgeHit = {
  id: string;
  connector: CollectionSourceId;
  sourceType: 'primary' | 'support' | 'meta' | 'seed';
  sourcePriority: number;
  sourceReliability: number;
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
  source: string;
  sourceUrl?: string;
  publisher?: string;
  retrievalHint?: string;
};

export type CollectedDatasetHit = {
  id: string;
  connector: CollectionSourceId;
  sourceType: 'primary' | 'support' | 'meta' | 'seed';
  sourcePriority: number;
  sourceReliability: number;
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
  provider: string;
  providerDetail?: string;
  publisher?: string;
  sourceUrl?: string;
  retrievalHint?: string;
};

export type CollectionJobStatusResponse = {
  jobId: string;
  query: string;
  kind: CollectionKind;
  requestedSources: CollectionSourceId[];
  status: DiscoveryJobStatus;
  stage: string;
  rawKnowledgeCount: number;
  rawDatasetCount: number;
  knowledgeCount: number;
  datasetCount: number;
  connectorStatuses: CollectionConnectorStatus[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type CollectionJobResultsResponse = {
  jobId: string;
  query: string;
  kind: CollectionKind;
  requestedSources: CollectionSourceId[];
  status: DiscoveryJobStatus;
  stage: string;
  datasetQueries: string[];
  knowledgeQueries: string[];
  mustInclude: string[];
  mustAvoid: string[];
  llmPlanRaw: string | null;
  llmPlan: CollectionLlmPlan | null;
  connectorStatuses: CollectionConnectorStatus[];
  rawKnowledgeHits: CollectedKnowledgeHit[];
  rawDatasetHits: CollectedDatasetHit[];
  knowledgeItems: ExternalKnowledgeItem[];
  datasetItems: ExternalDatasetItem[];
};

export type SessionRecord = {
  id: string;
  createdAt: string;
};

export type DatasetRecord = {
  id: string;
  sessionId: string;
  fileName: string;
  filePath: string;
  rowCount: number;
  colCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  targetColumns: string[];
  taskType: TaskType;
  description: string;
  createdAt: string;
  analysis?: DatasetAnalysisResponse;
  recommendation?: DomainRecommendationResponse;
  selectedExternalResources?: SelectedExternalResourcesRecord;
};

export type DiscoveryJobRecord = {
  id: string;
  sessionId: string;
  datasetId: string;
  selectedDomains: string[];
  metadataColumns: string[];
  status: DiscoveryJobStatus;
  stage: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  generatedQueries: string[];
  expandedKeywords: string[];
  knowledgeItems: ExternalKnowledgeItem[];
  datasetItems: ExternalDatasetItem[];
};

export type CollectionJobRecord = {
  id: string;
  query: string;
  kind: CollectionKind;
  requestedSources: CollectionSourceId[];
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  status: DiscoveryJobStatus;
  stage: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  datasetQueries: string[];
  knowledgeQueries: string[];
  mustInclude: string[];
  mustAvoid: string[];
  llmPlanRaw: string | null;
  llmPlan: CollectionLlmPlan | null;
  connectorStatuses: CollectionConnectorStatus[];
  rawKnowledgeHits: CollectedKnowledgeHit[];
  rawDatasetHits: CollectedDatasetHit[];
  knowledgeItems: ExternalKnowledgeItem[];
  datasetItems: ExternalDatasetItem[];
};

export type CreateDatasetInput = {
  sessionId: string;
  fileName: string;
  rawBuffer: Buffer;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  targetColumns: string[];
  taskType: TaskType;
  description: string;
};

export type DiscoveryContext = {
  dataset: DatasetRecord;
  selectedDomains: string[];
  selectedDomainIds: string[];
  primaryDomainId: string | null;
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  metadataColumns: string[];
  featureColumns: string[];
  textColumns: string[];
  idColumns: string[];
  temporalColumns: string[];
  supportColumns: string[];
  labelHints: string[];
  modality: 'text' | 'table' | 'hybrid';
  descriptionSignals: string[];
  expandedKeywords: string[];
  generatedQueries: string[];
};

export type DomainCatalogEntry = {
  id: string;
  title: string;
  shortDescription: string;
  keywords: string[];
  aliases?: string[];
  strongSignals?: string[];
  supportSignals?: string[];
  negativeSignals?: string[];
  querySeeds?: string[];
  reasonTemplate?: string;
  modality?: 'text' | 'table' | 'hybrid';
};

export type TaskCatalogEntry = {
  id: TaskSignal;
  title: string;
  aliases?: string[];
  strongSignals?: string[];
  supportSignals?: string[];
  querySeeds?: string[];
};

export type ModalityCatalogEntry = {
  id: ModalitySignal;
  title: string;
  aliases?: string[];
  keywords?: string[];
};

export type KnowledgeCatalogEntry = {
  id: string;
  title: string;
  source: string;
  summary: string;
  kind: ExternalKnowledgeKind;
  tags: string[];
  domainIds?: string[];
  sourceUrl?: string;
  publisher?: string;
  retrievalHint?: string;
  modality?: 'text' | 'table' | 'hybrid';
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  negativeTags?: string[];
};

export type DatasetCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  description: string;
  rowsHint: string;
  modality: string;
  licenseHint: string;
  tags: string[];
  domainIds?: string[];
  sourceUrl?: string;
  providerDetail?: string;
  publisher?: string;
  retrievalHint?: string;
  modalityType?: 'text' | 'table' | 'hybrid';
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  negativeTags?: string[];
};
