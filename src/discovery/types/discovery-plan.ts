import type { DiscoveryContext, ModalitySignal, TaskSignal } from '../../common/contracts';

export type DiscoveryPlan = {
  selectedDomainIds: string[];
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  knowledgeQueries: string[];
  datasetQueries: string[];
  mustInclude: string[];
  mustAvoid: string[];
};

export function planFromContext(context: DiscoveryContext): DiscoveryPlan {
  return {
    selectedDomainIds: [...context.selectedDomainIds],
    taskSignals: [...context.taskSignals],
    modalitySignals: [...context.modalitySignals],
    knowledgeQueries: [...context.generatedQueries],
    datasetQueries: [...context.generatedQueries],
    mustInclude: [...context.expandedKeywords],
    mustAvoid: [],
  };
}
