import { Injectable } from '@nestjs/common';
import { datasetCatalog, knowledgeCatalog } from '../common/catalog';
import type { DiscoveryContext } from '../common/contracts';
import { buildQueryMatchSignals, inferModalitySignals } from '../discovery/connectors/connector.utils';
import type { DiscoveryConnector } from '../discovery/connectors/connector.interface';
import type { DiscoveryPlan } from '../discovery/types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../discovery/types/discovery-hit';

@Injectable()
export class CatalogConnectorsService implements DiscoveryConnector {
  async searchKnowledgeHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    const hits = knowledgeCatalog.map((entry) =>
      this.buildKnowledgeHit(entry, plan, context),
    );

    return {
      hits,
      debug: hits.map((hit) => ({
        id: hit.id,
        connector: hit.connector,
        matchedQueries: hit.matchedQueries,
        matchedTerms: hit.matchedTerms,
      })),
    };
  }

  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const hits = datasetCatalog.map((entry) =>
      this.buildDatasetHit(entry, plan, context),
    );

    return {
      hits,
      debug: hits.map((hit) => ({
        id: hit.id,
        connector: hit.connector,
        matchedQueries: hit.matchedQueries,
        matchedTerms: hit.matchedTerms,
      })),
    };
  }

  private buildKnowledgeHit(
    entry: (typeof knowledgeCatalog)[number],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): KnowledgeDiscoveryHit {
    const text = `${entry.title} ${entry.summary} ${entry.source} ${entry.publisher ?? ''}`;
    const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
      text,
      entry.tags,
      plan.knowledgeQueries,
      plan.mustInclude,
    );

    return {
      id: entry.id,
      kind: 'knowledge',
      connector: 'seed-catalog',
      title: entry.title,
      text,
      tags: entry.tags,
      domainIds: entry.domainIds ?? [],
      taskSignals: entry.taskSignals ?? [],
      modalitySignals: entry.modalitySignals ?? inferModalitySignals(text, entry.tags, entry.modality ?? 'table'),
      modality: entry.modality ?? 'table',
      negativeTags: entry.negativeTags ?? [],
      matchedQueries,
      matchedTerms,
      entry,
    };
  }

  private buildDatasetHit(
    entry: (typeof datasetCatalog)[number],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): DatasetDiscoveryHit {
    const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.providerDetail ?? ''} ${entry.modality}`;
    const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
      text,
      entry.tags,
      plan.datasetQueries,
      plan.mustInclude,
    );

    return {
      id: entry.id,
      kind: 'dataset',
      connector: 'seed-catalog',
      title: entry.name,
      text,
      tags: entry.tags,
      domainIds: entry.domainIds ?? [],
      taskSignals: entry.taskSignals ?? [],
      modalitySignals:
        entry.modalitySignals ?? inferModalitySignals(text, entry.tags, entry.modalityType ?? 'table'),
      modality: entry.modalityType ?? 'table',
      negativeTags: entry.negativeTags ?? [],
      matchedQueries,
      matchedTerms,
      entry,
    };
  }
}
