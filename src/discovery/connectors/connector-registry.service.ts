import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../../common/contracts';
import { CatalogConnectorsService } from '../../connectors/catalog.connectors';
import type { DiscoveryConnector } from './connector.interface';
import type { DiscoveryPlan } from '../types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchDebug,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/discovery-hit';
import { envFlag } from './connector.utils';
import { HuggingFaceDatasetsConnector } from './huggingface-datasets.connector';
import { UciDatasetsConnector } from './uci-datasets.connector';
import { KaggleDatasetsConnector } from './kaggle-datasets.connector';
import { SerpApiKnowledgeConnector } from './serpapi-knowledge.connector';
import { CrossrefKnowledgeConnector } from './crossref-knowledge.connector';

@Injectable()
export class DiscoveryConnectorRegistryService {
  constructor(
    private readonly seedConnector: CatalogConnectorsService,
    private readonly huggingFaceConnector: HuggingFaceDatasetsConnector,
    private readonly uciConnector: UciDatasetsConnector,
    private readonly kaggleConnector: KaggleDatasetsConnector,
    private readonly serpApiConnector: SerpApiKnowledgeConnector,
    private readonly crossrefConnector: CrossrefKnowledgeConnector,
  ) {}

  async searchKnowledgeHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    return this.collectKnowledge(this.enabledConnectors(), plan, context);
  }

  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    return this.collectDatasets(this.enabledConnectors(), plan, context);
  }

  private enabledConnectors(): DiscoveryConnector[] {
    const connectors: DiscoveryConnector[] = [];
    if (envFlag('DISCOVERY_ENABLE_SEED_CONNECTOR', true)) {
      connectors.push(this.seedConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_HF_CONNECTOR')) {
      connectors.push(this.huggingFaceConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_UCI_CONNECTOR')) {
      connectors.push(this.uciConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_KAGGLE_CONNECTOR')) {
      connectors.push(this.kaggleConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_SERPAPI_CONNECTOR')) {
      connectors.push(this.serpApiConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_CROSSREF_CONNECTOR')) {
      connectors.push(this.crossrefConnector);
    }
    return connectors;
  }

  private async collectKnowledge(
    connectors: DiscoveryConnector[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    const settled = await Promise.allSettled(connectors.map((connector) => connector.searchKnowledgeHits(plan, context)));
    return this.mergeOutcomes(settled);
  }

  private async collectDatasets(
    connectors: DiscoveryConnector[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const settled = await Promise.allSettled(connectors.map((connector) => connector.searchDatasetHits(plan, context)));
    return this.mergeOutcomes(settled);
  }

  private mergeOutcomes<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    settled: PromiseSettledResult<DiscoverySearchOutcome<T>>[],
  ): DiscoverySearchOutcome<T> {
    const hits: T[] = [];
    const debug: DiscoverySearchDebug[] = [];
    const seen = new Set<string>();

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        const outcome = item.value;
        for (const entry of outcome.debug) {
          debug.push({
            ...entry,
            status: entry.status ?? 'ok',
          });
        }

        for (const hit of outcome.hits) {
          const dedupeKey = `${hit.kind}:${hit.entry.sourceUrl ?? ''}:${hit.title.toLowerCase()}`.trim();
          const fallbackKey = `${hit.kind}:${hit.connector}:${hit.id}`;
          const key = dedupeKey !== `${hit.kind}::` ? dedupeKey : fallbackKey;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          hits.push(hit);
        }
        continue;
      }

      debug.push({
        id: '__connector_error__',
        connector: 'unknown',
        matchedQueries: [],
        matchedTerms: [],
        status: 'error',
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      });
    }

    return { hits, debug };
  }
}
