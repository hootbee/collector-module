import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../common/contracts';
import { DiscoveryConnectorRegistryService } from './connectors/connector-registry.service';
import { DiscoveryNormalizerService } from './discovery-normalizer.service';
import { DiscoveryQueryPlannerService } from './discovery-query-planner.service';
import { DiscoveryRankingService } from './discovery-ranking.service';

@Injectable()
export class DiscoveryOrchestratorService {
  constructor(
    private readonly plannerService: DiscoveryQueryPlannerService,
    private readonly connectorsService: DiscoveryConnectorRegistryService,
    private readonly rankingService: DiscoveryRankingService,
    private readonly normalizerService: DiscoveryNormalizerService,
  ) {}

  async execute(context: DiscoveryContext) {
    const plan = this.plannerService.buildPlan(context);

    const [knowledgeSearch, datasetSearch] = await Promise.all([
      this.connectorsService.searchKnowledgeHits(plan, context),
      this.connectorsService.searchDatasetHits(plan, context),
    ]);

    const knowledgeRanking = this.rankingService.rankKnowledgeHits(knowledgeSearch.hits, context, plan);
    const datasetRanking = this.rankingService.rankDatasetHits(datasetSearch.hits, context, plan);

    return {
      plan,
      knowledgeSearchDebug: knowledgeSearch.debug,
      datasetSearchDebug: datasetSearch.debug,
      knowledgeRankingDebug: knowledgeRanking.debug,
      datasetRankingDebug: datasetRanking.debug,
      knowledgeItems: this.normalizerService.normalizeKnowledge(knowledgeRanking.items),
      datasetItems: this.normalizerService.normalizeDatasets(datasetRanking.items),
    };
  }
}
