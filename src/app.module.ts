import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CollectionController } from './collection/collection.controller';
import { CollectionLlmService } from './collection/collection-llm.service';
import { CollectionNormalizerService } from './collection/collection-normalizer.service';
import { CollectionOrchestratorService } from './collection/collection-orchestrator.service';
import { CollectionPlannerService } from './collection/collection-planner.service';
import { CollectionService } from './collection/collection.service';
import { CatalogConnectorsService } from './connectors/catalog.connectors';
import { DatasetsController } from './datasets/datasets.controller';
import { DiscoveryConnectorRegistryService } from './discovery/connectors/connector-registry.service';
import { CrossrefKnowledgeConnector } from './discovery/connectors/crossref-knowledge.connector';
import { HuggingFaceDatasetsConnector } from './discovery/connectors/huggingface-datasets.connector';
import { KaggleDatasetsConnector } from './discovery/connectors/kaggle-datasets.connector';
import { SerpApiKnowledgeConnector } from './discovery/connectors/serpapi-knowledge.connector';
import { UciDatasetsConnector } from './discovery/connectors/uci-datasets.connector';
import { OpenMlDatasetsConnector } from './discovery/connectors/openml-datasets.connector';
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
    CollectionController,
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
    OpenMlDatasetsConnector,
    DiscoveryConnectorRegistryService,
    DiscoveryQueryPlannerService,
    DiscoveryRankingService,
    DiscoveryNormalizerService,
    DiscoveryOrchestratorService,
    DiscoveryService,
    CollectionPlannerService,
    CollectionLlmService,
    CollectionNormalizerService,
    CollectionOrchestratorService,
    CollectionService,
  ],
})
export class AppModule {}
