import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../common/contracts';
import { uniqueKeepOrder } from '../common/text';
import type { DiscoveryPlan } from './types/discovery-plan';

@Injectable()
export class DiscoveryQueryPlannerService {
  buildPlan(context: DiscoveryContext): DiscoveryPlan {
    const baseQueries = uniqueKeepOrder(context.generatedQueries);
    const mustInclude = uniqueKeepOrder([
      ...context.expandedKeywords,
      ...context.labelHints,
      ...context.featureColumns.slice(0, 8),
      ...context.taskSignals,
      ...context.modalitySignals,
    ]).slice(0, 18);

    const mustAvoid = this.buildNegativeHints(context);

    const knowledgeQueries = uniqueKeepOrder([
      ...baseQueries,
      ...baseQueries.map((query) => `${query} guideline`),
      ...baseQueries.map((query) => `${query} paper`),
      ...baseQueries.map((query) => `${query} overview`),
    ]).slice(0, 8);

    const datasetQueries = uniqueKeepOrder([
      ...baseQueries,
      ...baseQueries.map((query) => `${query} dataset`),
      ...baseQueries.map((query) => `${query} benchmark`),
      ...baseQueries.map((query) => `${query} corpus`),
    ]).slice(0, 8);

    return {
      selectedDomainIds: [...context.selectedDomainIds],
      taskSignals: [...context.taskSignals],
      modalitySignals: [...context.modalitySignals],
      knowledgeQueries,
      datasetQueries,
      mustInclude,
      mustAvoid,
    };
  }

  private buildNegativeHints(context: DiscoveryContext): string[] {
    if (context.modalitySignals.includes('text')) {
      return uniqueKeepOrder([
        'clinical',
        'patient',
        'fraud',
        'transaction',
        'sensor',
        'turbofan',
      ]);
    }

    if (
      context.selectedDomainIds.includes('dom-finance') &&
      context.taskSignals.includes('time-series-forecasting')
    ) {
      return uniqueKeepOrder([
        'patient',
        'clinical',
        'essay',
        'authorship',
        'generated text',
        'fraud',
        'chargeback',
      ]);
    }

    if (context.selectedDomainIds.includes('dom-medical')) {
      return uniqueKeepOrder([
        'authorship',
        'essay',
        'generated text',
        'fraud',
      ]);
    }

    return [];
  }
}
