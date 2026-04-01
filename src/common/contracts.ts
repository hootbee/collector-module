export type TaskType = 'classification' | 'anomaly' | 'regression';
export type DiscoveryJobStatus = 'queued' | 'running' | 'completed' | 'failed';

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
};

export type DomainRecommendationResponse = {
  sessionId: string;
  datasetId: string;
  datasetSummary: DomainDatasetSummary;
  evidenceSummary: DomainEvidenceSummary;
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
  metadataColumns: string[];
  expandedKeywords: string[];
  generatedQueries: string[];
};

export type DomainCatalogEntry = {
  id: string;
  title: string;
  shortDescription: string;
  keywords: string[];
};

export type KnowledgeCatalogEntry = {
  id: string;
  title: string;
  source: string;
  summary: string;
  kind: ExternalKnowledgeKind;
  tags: string[];
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
};
