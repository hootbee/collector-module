import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { DomainRecommendationService } from './domain-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

@Controller('domains')
export class DomainRecommendationController {
  constructor(
    private readonly storeService: StoreService,
    private readonly profilingService: ProfilingService,
    private readonly recommendationService: DomainRecommendationService,
  ) {}

  @Post('recommend')
  recommendDomains(
    @Body()
    body: {
      datasetId?: string;
      metadataColumns?: string[];
      refreshSeed?: number;
    },
  ) {
    const datasetId = body.datasetId?.trim() ?? '';
    if (!datasetId) {
      throw new BadRequestException('datasetId is required.');
    }

    if (
      body.metadataColumns != null &&
      (!Array.isArray(body.metadataColumns) || body.metadataColumns.some((item) => typeof item !== 'string'))
    ) {
      throw new BadRequestException('metadataColumns must be a string array.');
    }

    if (body.refreshSeed != null && typeof body.refreshSeed !== 'number') {
      throw new BadRequestException('refreshSeed must be a number.');
    }

    const dataset = this.storeService.getDataset(datasetId);
    if (!dataset) {
      throw new NotFoundException(`Dataset ${datasetId} was not found.`);
    }

    if (!dataset.analysis) {
      this.storeService.setDatasetAnalysis(dataset.id, this.profilingService.analyzeDataset(dataset));
    }

    const recommendation = this.recommendationService.recommendDataset({
      dataset,
      metadataColumns: body.metadataColumns ?? [],
      refreshSeed: body.refreshSeed,
    });

    return this.storeService.setDatasetRecommendation(dataset.id, recommendation);
  }
}
