import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';

@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Post('jobs')
  async createJob(
    @Body()
    body: {
      datasetId?: string;
      metadataColumns?: string[];
      selectedDomains?: string[];
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

    if (
      body.selectedDomains != null &&
      (!Array.isArray(body.selectedDomains) || body.selectedDomains.some((item) => typeof item !== 'string'))
    ) {
      throw new BadRequestException('selectedDomains must be a string array.');
    }

    return this.discoveryService.createJob({
      datasetId,
      metadataColumns: body.metadataColumns ?? [],
      selectedDomains: body.selectedDomains ?? [],
    });
  }

  @Get('jobs/:jobId')
  getJobStatus(@Param('jobId') jobId: string) {
    return this.discoveryService.getStatus(jobId);
  }

  @Get('jobs/:jobId/results')
  getJobResults(@Param('jobId') jobId: string) {
    return this.discoveryService.getResults(jobId);
  }
}
