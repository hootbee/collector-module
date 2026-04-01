import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CatalogConnectorsService } from './connectors/catalog.connectors';
import { DatasetsController } from './datasets/datasets.controller';
import { DiscoveryController } from './discovery/discovery.controller';
import { DiscoveryService } from './discovery/discovery.service';
import { DomainRecommendationController } from './domain-recommendation/domain-recommendation.controller';
import { DomainRecommendationService } from './domain-recommendation/domain-recommendation.service';
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
    CatalogConnectorsService,
    DiscoveryService,
  ],
})
export class AppModule {}
