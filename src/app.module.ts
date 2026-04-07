import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CatalogConnectorsService } from './connectors/catalog.connectors';
import { DatasetsController } from './datasets/datasets.controller';
import { DiscoveryConnectorRegistryService } from './discovery/connectors/connector-registry.service';
import { CrossrefKnowledgeConnector } from './discovery/connectors/crossref-knowledge.connector';
import { HuggingFaceDatasetsConnector } from './discovery/connectors/huggingface-datasets.connector';
import { KaggleDatasetsConnector } from './discovery/connectors/kaggle-datasets.connector';
import { SerpApiKnowledgeConnector } from './discovery/connectors/serpapi-knowledge.connector';
import { UciDatasetsConnector } from './discovery/connectors/uci-datasets.connector';
import { DiscoveryController } from './discovery/discovery.controller';
import { DiscoveryNormalizerService } from './discovery/discovery-normalizer.service';
import { DiscoveryOrchestratorService } from './discovery/discovery-orchestrator.service';
import { DiscoveryQueryPlannerService } from './discovery/discovery-query-planner.service';
import { DiscoveryRankingService } from './discovery/discovery-ranking.service';
import { DiscoveryService } from './discovery/discovery.service';
import { DomainRecommendationController } from './domain-recommendation/domain-recommendation.controller';
import { DomainRecommendationService } from './domain-recommendation/domain-recommendation.service';
import { OpenAiRecommendationService } from './llm/openai-recommendation.service';
import { ProfilingService } from './profiling/profiling.service';
import { SessionsController } from './sessions/sessions.controller';
import { StoreService } from './store/store.service';

@Module({
  controllers: [
    AppController,
    SessionsController,
    DatasetsController,
    DomainRecommendationController,
    DiscoveryController,
  ],
  providers: [
    StoreService,
    ProfilingService,
    DomainRecommendationService,
    OpenAiRecommendationService,
    CatalogConnectorsService,
    HuggingFaceDatasetsConnector,
    UciDatasetsConnector,
    KaggleDatasetsConnector,
    SerpApiKnowledgeConnector,
    CrossrefKnowledgeConnector,
    DiscoveryConnectorRegistryService,
    DiscoveryQueryPlannerService,
    DiscoveryRankingService,
    DiscoveryNormalizerService,
    DiscoveryOrchestratorService,
    DiscoveryService,
  ],
})
export class AppModule {}
