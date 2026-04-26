import { Injectable } from '@nestjs/common';
import type { CollectionSourceId } from '../../common/contracts';
import {
  genericDatasetSources,
  genericKnowledgeSources,
  structuredDatasetSources,
  structuredDatasetThreshold,
  structuredKnowledgeSources,
  structuredKnowledgeThreshold,
} from './collection-layer.config';
import { CollectionConnectorRegistryService } from './connectors/connector-registry.service';
import { CollectionLlmService } from './collection-llm.service';
import { CollectionNormalizerService } from './collection-normalizer.service';
import { CollectionOrderingService } from './collection-ordering.service';
import { CollectionPlannerService, type CollectionRequest } from './collection-planner.service';
import { CollectionSerpResultFilterService } from './collection-serp-result-filter.service';
import { CollectionWebRoutingService } from './collection-web-routing.service';

@Injectable()
export class CollectionOrchestratorService {
  constructor(
    private readonly plannerService: CollectionPlannerService,
    private readonly connectorsService: CollectionConnectorRegistryService,
    private readonly normalizerService: CollectionNormalizerService,
    private readonly orderingService: CollectionOrderingService,
    private readonly serpResultFilterService: CollectionSerpResultFilterService,
    private readonly llmService: CollectionLlmService,
    private readonly webRoutingService: CollectionWebRoutingService,
  ) {}

  async execute(request: CollectionRequest) {
    const baseline = this.plannerService.build(request);
    const llmPlanning = await this.llmService.planQueries({
      query: request.query,
      kind: request.kind,
      requestedSources: request.requestedSources,
      taskSignals: baseline.context.taskSignals,
      modalitySignals: baseline.context.modalitySignals,
      datasetQueries: baseline.plan.canonicalDatasetQueries,
      knowledgeQueries: baseline.plan.canonicalKnowledgeQueries,
      mustInclude: baseline.plan.mustInclude,
      mustAvoid: baseline.plan.mustAvoid,
    });
    const { context, plan } = this.plannerService.build({
      ...request,
      llmPlan: llmPlanning?.plan ?? null,
    });
    const requestedSources = [...new Set(request.requestedSources)];
    const structuredKnowledgeRequested = requestedSources.filter((source) => structuredKnowledgeSources.includes(source));
    const structuredDatasetRequested = requestedSources.filter((source) => structuredDatasetSources.includes(source));
    const genericKnowledgeRequested = requestedSources.filter((source) => genericKnowledgeSources.includes(source));
    const genericDatasetRequested = requestedSources.filter((source) => genericDatasetSources.includes(source));

    const [structuredKnowledgeSearch, structuredDatasetSearch] = await Promise.all([
      request.kind === 'dataset' || structuredKnowledgeRequested.length === 0
        ? Promise.resolve({ hits: [], debug: [] })
        : this.connectorsService.searchKnowledgeHitsForSources(structuredKnowledgeRequested, plan, context),
      request.kind === 'knowledge' || structuredDatasetRequested.length === 0
        ? Promise.resolve({ hits: [], debug: [] })
        : this.connectorsService.searchDatasetHitsForSources(structuredDatasetRequested, plan, context),
    ]);
    const structuredKnowledge = await this.webRoutingService.annotateStructuredKnowledgeHits(
      structuredKnowledgeSearch.hits,
    );
    const structuredDataset = await this.webRoutingService.annotateStructuredDatasetHits(
      structuredDatasetSearch.hits,
    );

    const shouldRunGenericKnowledge =
      request.kind !== 'dataset' &&
      genericKnowledgeRequested.length > 0 &&
      structuredKnowledge.hits.length < structuredKnowledgeThreshold(requestedSources);
    const shouldRunGenericDataset =
      request.kind !== 'knowledge' &&
      genericDatasetRequested.length > 0 &&
      structuredDataset.hits.length < structuredDatasetThreshold(requestedSources);

    const [genericKnowledgeSearch, genericDatasetSearch] = await Promise.all([
      shouldRunGenericKnowledge
        ? this.connectorsService.searchKnowledgeHitsForSources(genericKnowledgeRequested, plan, context)
        : Promise.resolve({ hits: [], debug: [] }),
      shouldRunGenericDataset
        ? this.connectorsService.searchDatasetHitsForSources(genericDatasetRequested, plan, context)
        : Promise.resolve({ hits: [], debug: [] }),
    ]);

    const [filteredGenericKnowledgeHits, filteredGenericDatasetHits] = await Promise.all([
      this.serpResultFilterService.filterKnowledgeHits(
        genericKnowledgeSearch.hits,
        plan,
        context,
      ),
      this.serpResultFilterService.filterDatasetHits(
        genericDatasetSearch.hits,
        plan,
        context,
      ),
    ]);

    const genericKnowledge = await this.webRoutingService.routeGenericKnowledgeHits(
      filteredGenericKnowledgeHits,
    );
    const genericDataset = await this.webRoutingService.routeGenericDatasetHits(
      filteredGenericDatasetHits,
    );

    const rankedKnowledge = this.orderingService.orderKnowledgeHits(
      [...structuredKnowledge.hits, ...genericKnowledge.hits],
      plan,
      context,
    );
    const rankedDataset = this.orderingService.orderDatasetHits(
      [...structuredDataset.hits, ...genericDataset.hits],
      plan,
      context,
    );
    const orderedKnowledgeHits = rankedKnowledge.items.map((item) => item.hit);
    const orderedDatasetHits = rankedDataset.items.map((item) => item.hit);
    const routedHits = [
      ...structuredKnowledge.routedHits,
      ...structuredDataset.routedHits,
      ...genericKnowledge.routedHits,
      ...genericDataset.routedHits,
    ];
    const fetchedDocuments = [
      ...structuredKnowledge.fetchedDocuments,
      ...structuredDataset.fetchedDocuments,
      ...genericKnowledge.fetchedDocuments,
      ...genericDataset.fetchedDocuments,
    ];

    return {
      context,
      plan,
      llmPlanRaw: llmPlanning?.rawOutput ?? null,
      llmPlan: llmPlanning?.plan ?? null,
      connectorStatuses: this.connectorSummary(
        requestedSources,
        [
          ...structuredKnowledgeSearch.debug,
          ...structuredDatasetSearch.debug,
          ...genericKnowledgeSearch.debug,
          ...genericDatasetSearch.debug,
        ],
        orderedKnowledgeHits.map((hit) => hit.connector as CollectionSourceId),
        orderedDatasetHits.map((hit) => hit.connector as CollectionSourceId),
      ),
      routedHits,
      fetchedDocuments,
      rawKnowledgeHits: this.normalizerService.toRawKnowledgeHits(orderedKnowledgeHits),
      rawDatasetHits: this.normalizerService.toRawDatasetHits(orderedDatasetHits),
      knowledgeItems: this.normalizerService.normalizeKnowledgeFromRanked(
        rankedKnowledge.items,
      ),
      datasetItems: this.normalizerService.normalizeDatasetsFromRanked(
        rankedDataset.items,
      ),
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
