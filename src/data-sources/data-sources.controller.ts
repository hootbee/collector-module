import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DataSourcesService } from './data-sources.service';

@Controller('data-sources')
export class DataSourcesController {
  constructor(private readonly dataSourcesService: DataSourcesService) {}

  @Get()
  list(@Query('userId') userId?: string) {
    return this.dataSourcesService.list(userId);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.dataSourcesService.create(body);
  }

  @Get(':dataSourceId')
  get(@Param('dataSourceId') dataSourceId: string) {
    return this.dataSourcesService.get(dataSourceId);
  }

  @Patch(':dataSourceId')
  update(
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.dataSourcesService.update(dataSourceId, body);
  }

  @Patch(':dataSourceId/linked-pipeline')
  updateLinkedPipeline(
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: { linkedPipelineId?: string | null },
  ) {
    return this.dataSourcesService.updateLinkedPipeline(dataSourceId, body.linkedPipelineId);
  }

  @Delete(':dataSourceId')
  delete(@Param('dataSourceId') dataSourceId: string) {
    return this.dataSourcesService.delete(dataSourceId);
  }
}
