import type {
  DatasetCatalogEntry,
  KnowledgeCatalogEntry,
  ModalitySignal,
  TaskSignal,
} from '../../common/contracts';

export type DiscoveryHitKind = 'knowledge' | 'dataset';

export type DiscoveryHitBase = {
  id: string;
  kind: DiscoveryHitKind;
  connector: string;
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
};

export type KnowledgeDiscoveryHit = DiscoveryHitBase & {
  kind: 'knowledge';
  entry: KnowledgeCatalogEntry;
};

export type DatasetDiscoveryHit = DiscoveryHitBase & {
  kind: 'dataset';
  entry: DatasetCatalogEntry;
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
  matchedKeywords: string[];
  matchedReason: string;
  filteredOutReason: string | null;
};

export type DiscoveryRankingDebug = {
  id: string;
  score: number;
  matchedKeywords: string[];
  matchedReason: string;
  filteredOutReason: string | null;
};

export type DiscoveryRankingOutcome<T> = {
  items: RankedDiscoveryHit<T>[];
  debug: DiscoveryRankingDebug[];
};
