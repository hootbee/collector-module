import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CollectionController } from './collection/collection.controller';
import { DatabaseModule } from './database/database.module';
import { CollectionConnectorRegistryService } from './collection/connectors/connector-registry.service';
import { CrossrefKnowledgeConnector } from './collection/connectors/crossref-knowledge.connector';
import { HuggingFaceDatasetsConnector } from './collection/connectors/huggingface-datasets.connector';
import { KaggleDatasetsConnector } from './collection/connectors/kaggle-datasets.connector';
import { OpenMlDatasetsConnector } from './collection/connectors/openml-datasets.connector';
import { SeedCatalogConnector } from './collection/connectors/seed-catalog.connector';
import { SerpApiKnowledgeConnector } from './collection/connectors/serpapi-knowledge.connector';
import { UciDatasetsConnector } from './collection/connectors/uci-datasets.connector';
import { CollectionGenericHtmlLlmService } from './collection/collection-generic-html-llm.service';
import { CollectionHtmlExtractionService } from './collection/collection-html-extraction.service';
import { CollectionBrowserFallbackService } from './collection/collection-browser-fallback.service';
import { CollectionLlmClientService } from './collection/collection-llm-client.service';
import { CollectionLlmService } from './collection/collection-llm.service';
import { CollectionNormalizerService } from './collection/collection-normalizer.service';
import { CollectionOrchestratorService } from './collection/collection-orchestrator.service';
import { CollectionPlannerService } from './collection/collection-planner.service';
import { CollectionDownloadService } from './collection/collection-download.service';
import { CollectionService } from './collection/collection.service';
import { CollectionOrderingService } from './collection/collection-ordering.service';
import { CollectionSerpResultFilterService } from './collection/collection-serp-result-filter.service';
import { CollectionWebRoutingService } from './collection/collection-web-routing.service';
import { StoreModule } from './store/store.module';

@Module({
  imports: [StoreModule, DatabaseModule, AuthModule],
  controllers: [AppController, CollectionController],
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
  ],
})
export class AppModule {}
