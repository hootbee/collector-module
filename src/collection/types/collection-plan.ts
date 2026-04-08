import type { DiscoveryContext, ModalitySignal, TaskSignal } from '../../common/contracts';

export type DatasetDiscoverySource =
  | 'seed-catalog'
  | 'huggingface'
  | 'openml'
  | 'uci'
  | 'kaggle'
  | 'serpapi';
export type KnowledgeDiscoverySource = 'seed-catalog' | 'serpapi' | 'crossref';

export type DiscoveryPlan = {
  selectedDomainIds: string[];
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  canonicalKnowledgeQueries: string[];
  fallbackKnowledgeQueries: string[];
  knowledgeQueries: string[];
  canonicalDatasetQueries: string[];
  fallbackDatasetQueries: string[];
  datasetQueries: string[];
  datasetSourceQueries: Record<DatasetDiscoverySource, string[]>;
  knowledgeSourceQueries: Record<KnowledgeDiscoverySource, string[]>;
  mustInclude: string[];
  mustAvoid: string[];
};

export function planFromContext(context: DiscoveryContext): DiscoveryPlan {
  return {
    selectedDomainIds: [...context.selectedDomainIds],
    taskSignals: [...context.taskSignals],
    modalitySignals: [...context.modalitySignals],
    canonicalKnowledgeQueries: [...context.generatedQueries],
    fallbackKnowledgeQueries: [],
    knowledgeQueries: [...context.generatedQueries],
    canonicalDatasetQueries: [...context.generatedQueries],
    fallbackDatasetQueries: [],
    datasetQueries: [...context.generatedQueries],
    datasetSourceQueries: {
      'seed-catalog': [...context.generatedQueries],
      huggingface: [...context.generatedQueries],
      openml: [...context.generatedQueries],
      uci: [...context.generatedQueries],
      kaggle: [...context.generatedQueries],
      serpapi: [...context.generatedQueries],
    },
    knowledgeSourceQueries: {
      'seed-catalog': [...context.generatedQueries],
      serpapi: [...context.generatedQueries],
      crossref: [...context.generatedQueries],
    },
    mustInclude: [...context.expandedKeywords],
    mustAvoid: [],
  };
}

export function datasetQueriesForSource(plan: DiscoveryPlan, source: DatasetDiscoverySource): string[] {
  return plan.datasetSourceQueries[source] ?? plan.datasetQueries;
}

export function knowledgeQueriesForSource(plan: DiscoveryPlan, source: KnowledgeDiscoverySource): string[] {
  return plan.knowledgeSourceQueries[source] ?? plan.knowledgeQueries;
}
