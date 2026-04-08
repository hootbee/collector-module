import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CollectionController } from './collection/collection.controller';
import { CollectionConnectorRegistryService } from './collection/connectors/connector-registry.service';
import { CrossrefKnowledgeConnector } from './collection/connectors/crossref-knowledge.connector';
import { HuggingFaceDatasetsConnector } from './collection/connectors/huggingface-datasets.connector';
import { KaggleDatasetsConnector } from './collection/connectors/kaggle-datasets.connector';
import { OpenMlDatasetsConnector } from './collection/connectors/openml-datasets.connector';
import { SeedCatalogConnector } from './collection/connectors/seed-catalog.connector';
import { SerpApiKnowledgeConnector } from './collection/connectors/serpapi-knowledge.connector';
import { UciDatasetsConnector } from './collection/connectors/uci-datasets.connector';
import { CollectionLlmService } from './collection/collection-llm.service';
import { CollectionNormalizerService } from './collection/collection-normalizer.service';
import { CollectionOrchestratorService } from './collection/collection-orchestrator.service';
import { CollectionPlannerService } from './collection/collection-planner.service';
import { CollectionService } from './collection/collection.service';
import { CollectionWebRoutingService } from './collection/collection-web-routing.service';
import { StoreService } from './store/store.service';

@Module({
  controllers: [AppController, CollectionController],
  providers: [
    StoreService,
    SeedCatalogConnector,
    HuggingFaceDatasetsConnector,
    UciDatasetsConnector,
    KaggleDatasetsConnector,
    SerpApiKnowledgeConnector,
    CrossrefKnowledgeConnector,
    OpenMlDatasetsConnector,
    CollectionConnectorRegistryService,
    CollectionPlannerService,
    CollectionLlmService,
    CollectionNormalizerService,
    CollectionWebRoutingService,
    CollectionOrchestratorService,
    CollectionService,
  ],
})
export class AppModule {}
