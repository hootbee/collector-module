import { Injectable } from '@nestjs/common';
import type { CollectionSourceId, DiscoveryContext } from '../../common/contracts';
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
import { OpenMlDatasetsConnector } from './openml-datasets.connector';

@Injectable()
export class DiscoveryConnectorRegistryService {
  constructor(
    private readonly seedConnector: CatalogConnectorsService,
    private readonly huggingFaceConnector: HuggingFaceDatasetsConnector,
    private readonly uciConnector: UciDatasetsConnector,
    private readonly kaggleConnector: KaggleDatasetsConnector,
    private readonly serpApiConnector: SerpApiKnowledgeConnector,
    private readonly crossrefConnector: CrossrefKnowledgeConnector,
    private readonly openMlConnector: OpenMlDatasetsConnector,
  ) {}

  async searchKnowledgeHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    return this.collectKnowledge(this.enabledConnectors(), plan, context);
  }

  async searchKnowledgeHitsForSources(
    sources: CollectionSourceId[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    return this.collectKnowledge(this.enabledConnectors(sources), plan, context);
  }

  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    return this.collectDatasets(this.enabledConnectors(), plan, context);
  }

  async searchDatasetHitsForSources(
    sources: CollectionSourceId[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    return this.collectDatasets(this.enabledConnectors(sources), plan, context);
  }

  private enabledConnectors(requestedSources?: CollectionSourceId[]): DiscoveryConnector[] {
    const requested = requestedSources ? new Set(requestedSources) : null;
    const connectors: DiscoveryConnector[] = [];
    if (envFlag('DISCOVERY_ENABLE_SEED_CONNECTOR', true) && (!requested || requested.has('seed-catalog'))) {
      connectors.push(this.seedConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_HF_CONNECTOR') && (!requested || requested.has('huggingface'))) {
      connectors.push(this.huggingFaceConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_UCI_CONNECTOR') && (!requested || requested.has('uci'))) {
      connectors.push(this.uciConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_KAGGLE_CONNECTOR') && (!requested || requested.has('kaggle'))) {
      connectors.push(this.kaggleConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_SERPAPI_CONNECTOR') && (!requested || requested.has('serpapi'))) {
      connectors.push(this.serpApiConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_CROSSREF_CONNECTOR') && (!requested || requested.has('crossref'))) {
      connectors.push(this.crossrefConnector);
    }
    if (envFlag('DISCOVERY_ENABLE_OPENML_CONNECTOR') && (!requested || requested.has('openml'))) {
      connectors.push(this.openMlConnector);
    }
    return connectors;
  }

  private async collectKnowledge(
    connectors: DiscoveryConnector[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    const settled = await Promise.all(
      connectors.map(async (connector) => {
        const connectorName = this.connectorName(connector);
        try {
          return {
            connector: connectorName,
            outcome: await connector.searchKnowledgeHits(plan, context),
          };
        } catch (error) {
          return {
            connector: connectorName,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return this.mergeOutcomes(settled);
  }

  private async collectDatasets(
    connectors: DiscoveryConnector[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const settled = await Promise.all(
      connectors.map(async (connector) => {
        const connectorName = this.connectorName(connector);
        try {
          return {
            connector: connectorName,
            outcome: await connector.searchDatasetHits(plan, context),
          };
        } catch (error) {
          return {
            connector: connectorName,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return this.mergeOutcomes(settled);
  }

  private mergeOutcomes<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    settled: Array<
      | { connector: string; outcome: DiscoverySearchOutcome<T> }
      | { connector: string; error: string }
    >,
  ): DiscoverySearchOutcome<T> {
    const hits: T[] = [];
    const debug: DiscoverySearchDebug[] = [];
    const seen = new Set<string>();

    for (const item of settled) {
      if ('outcome' in item) {
        const outcome = item.outcome;
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
        connector: item.connector,
        matchedQueries: [],
        matchedTerms: [],
        status: 'error',
        error: item.error,
      });
    }

    return { hits, debug };
  }

  private connectorName(connector: DiscoveryConnector): string {
    if (connector === this.seedConnector) {
      return 'seed-catalog';
    }
    if (connector === this.huggingFaceConnector) {
      return 'huggingface';
    }
    if (connector === this.uciConnector) {
      return 'uci';
    }
    if (connector === this.kaggleConnector) {
      return 'kaggle';
    }
    if (connector === this.serpApiConnector) {
      return 'serpapi';
    }
    if (connector === this.crossrefConnector) {
      return 'crossref';
    }
    if (connector === this.openMlConnector) {
      return 'openml';
    }
    return connector.constructor?.name ?? 'unknown';
  }
}
