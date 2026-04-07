import { Injectable } from '@nestjs/common';
import type { CollectionSourceId } from '../common/contracts';
import { DiscoveryConnectorRegistryService } from '../discovery/connectors/connector-registry.service';
import { CollectionNormalizerService } from './collection-normalizer.service';
import { CollectionPlannerService, type CollectionRequest } from './collection-planner.service';

@Injectable()
export class CollectionOrchestratorService {
  constructor(
    private readonly plannerService: CollectionPlannerService,
    private readonly connectorsService: DiscoveryConnectorRegistryService,
    private readonly normalizerService: CollectionNormalizerService,
  ) {}

  async execute(request: CollectionRequest) {
    const { context, plan } = this.plannerService.build(request);
    const requestedSources = request.requestedSources;

    const [knowledgeSearch, datasetSearch] = await Promise.all([
      request.kind === 'dataset'
        ? Promise.resolve({ hits: [], debug: [] })
        : this.connectorsService.searchKnowledgeHitsForSources(requestedSources, plan, context),
      request.kind === 'knowledge'
        ? Promise.resolve({ hits: [], debug: [] })
        : this.connectorsService.searchDatasetHitsForSources(requestedSources, plan, context),
    ]);

    return {
      context,
      plan,
      connectorStatuses: this.connectorSummary(
        requestedSources,
        [...knowledgeSearch.debug, ...datasetSearch.debug],
        knowledgeSearch.hits.map((hit) => hit.connector as CollectionSourceId),
        datasetSearch.hits.map((hit) => hit.connector as CollectionSourceId),
      ),
      rawKnowledgeHits: this.normalizerService.toRawKnowledgeHits(knowledgeSearch.hits),
      rawDatasetHits: this.normalizerService.toRawDatasetHits(datasetSearch.hits),
      knowledgeItems: this.normalizerService.normalizeKnowledge(knowledgeSearch.hits),
      datasetItems: this.normalizerService.normalizeDatasets(datasetSearch.hits),
    };
  }

  private connectorSummary(
    requestedSources: CollectionSourceId[],
    debugEntries: Array<{
      connector: string;
      status?: 'ok' | 'error';
      count?: number;
      error?: string;
    }>,
    knowledgeHitConnectors: CollectionSourceId[],
    datasetHitConnectors: CollectionSourceId[],
  ) {
    return requestedSources.map((connector) => {
      const entries = debugEntries.filter((entry) => entry.connector === connector);
      const rawCount =
        knowledgeHitConnectors.filter((item) => item === connector).length +
        datasetHitConnectors.filter((item) => item === connector).length;
      if (entries.length === 0) {
        return {
          connector,
          status: 'ok' as const,
          count: rawCount,
          errors: [],
        };
      }

      const count = Math.max(rawCount, entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0));
      const errors = entries
        .filter((entry) => entry.status === 'error' && entry.error)
        .map((entry) => entry.error as string)
        .slice(0, 5);

      return {
        connector,
        status: errors.length > 0 ? 'error' as const : 'ok' as const,
        count,
        errors,
      };
    });
  }
}
