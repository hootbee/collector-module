import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CollectionController } from './modules/collection/collection.controller';
import { DataSourcesController } from './data-sources/data-sources.controller';
import { DataSourcesService } from './data-sources/data-sources.service';
import { DatabaseModule } from './database/database.module';
import { CollectionConnectorRegistryService } from './modules/collection/connectors/connector-registry.service';
import { CrossrefKnowledgeConnector } from './modules/collection/connectors/crossref-knowledge.connector';
import { HuggingFaceDatasetsConnector } from './modules/collection/connectors/huggingface-datasets.connector';
import { KaggleDatasetsConnector } from './modules/collection/connectors/kaggle-datasets.connector';
import { OpenMlDatasetsConnector } from './modules/collection/connectors/openml-datasets.connector';
import { SeedCatalogConnector } from './modules/collection/connectors/seed-catalog.connector';
import { SerpApiKnowledgeConnector } from './modules/collection/connectors/serpapi-knowledge.connector';
import { UciDatasetsConnector } from './modules/collection/connectors/uci-datasets.connector';
import { CollectionGenericHtmlLlmService } from './modules/collection/collection-generic-html-llm.service';
import { CollectionHtmlExtractionService } from './modules/collection/collection-html-extraction.service';
import { CollectionBrowserFallbackService } from './modules/collection/collection-browser-fallback.service';
import { CollectionLlmClientService } from './modules/collection/collection-llm-client.service';
import { CollectionLlmService } from './modules/collection/collection-llm.service';
import { CollectionNormalizerService } from './modules/collection/collection-normalizer.service';
import { CollectionOrchestratorService } from './modules/collection/collection-orchestrator.service';
import { CollectionPlannerService } from './modules/collection/collection-planner.service';
import { CollectionDownloadService } from './modules/collection/collection-download.service';
import { CollectionService } from './modules/collection/collection.service';
import { CollectionOrderingService } from './modules/collection/collection-ordering.service';
import { CollectionSerpResultFilterService } from './modules/collection/collection-serp-result-filter.service';
import { CollectionWebRoutingService } from './modules/collection/collection-web-routing.service';
import { OrchestratorController } from './orchestrator/orchestrator.controller';
import { OrchestratorModuleRegistryService } from './orchestrator/orchestrator-module-registry.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { ModulesCatalogController } from './modules-catalog/modules-catalog.controller';
import { ModulesCatalogService } from './modules-catalog/modules-catalog.service';
import { PipelinesController } from './pipelines/pipelines.controller';
import { PipelinesService } from './pipelines/pipelines.service';
import { StoreModule } from './store/store.module';

@Module({
  imports: [StoreModule, DatabaseModule, AuthModule],
  controllers: [
    AppController,
    CollectionController,
    OrchestratorController,
    PipelinesController,
    DataSourcesController,
    ModulesCatalogController,
  ],
  providers: [
    SeedCatalogConnector,
    HuggingFaceDatasetsConnector,
    UciDatasetsConnector,
    KaggleDatasetsConnector,
    SerpApiKnowledgeConnector,
    CrossrefKnowledgeConnector,
    OpenMlDatasetsConnector,
    CollectionConnectorRegistryService,
    CollectionPlannerService,
    CollectionLlmClientService,
    CollectionLlmService,
    CollectionGenericHtmlLlmService,
    CollectionHtmlExtractionService,
    CollectionBrowserFallbackService,
    CollectionSerpResultFilterService,
    CollectionOrderingService,
    CollectionNormalizerService,
    CollectionWebRoutingService,
    CollectionOrchestratorService,
    CollectionDownloadService,
    CollectionService,
    OrchestratorModuleRegistryService,
    OrchestratorService,
    PipelinesService,
    DataSourcesService,
    ModulesCatalogService,
  ],
})
export class AppModule {}
