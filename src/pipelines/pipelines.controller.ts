import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';

@Controller()
export class PipelinesController {
  constructor(private readonly pipelinesService: PipelinesService) {}

  @Get('pipeline-templates')
  listSharedTemplates() {
    return this.pipelinesService.listSharedTemplates();
  }

  @Get('pipeline-templates/:templateId')
  getSharedTemplate(@Param('templateId') templateId: string) {
    return this.pipelinesService.getSharedTemplate(templateId);
  }

  @Post('pipeline-templates/:templateId/copy')
  copySharedTemplate(
    @Param('templateId') templateId: string,
    @Body() body: { userId?: string; title?: string },
  ) {
    return this.pipelinesService.copySharedTemplate(templateId, {
      userId: body.userId,
      title: body.title,
    });
  }

  @Get('pipelines')
  listPipelines(@Query('userId') userId?: string) {
    return this.pipelinesService.listPipelines(userId?.trim() || null);
  }

  @Post('pipelines')
  createPipeline(
    @Body()
    body: {
      userId?: string;
      kind?: string;
      domainKey?: string;
      domainLabel?: string;
      title?: string;
      description?: string;
      moduleIds?: string[];
      connectedAfter?: string[];
      moduleLayout?: Record<string, unknown>;
      highlight?: string;
      autoNamed?: boolean;
    },
  ) {
    return this.pipelinesService.createPipeline(body);
  }

  @Get('pipelines/:pipelineId')
  getPipeline(@Param('pipelineId') pipelineId: string) {
    return this.pipelinesService.getPipeline(pipelineId);
  }

  @Patch('pipelines/:pipelineId')
  updatePipeline(
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      userId?: string;
      kind?: string;
      domainKey?: string;
      domainLabel?: string;
      title?: string;
      description?: string;
      highlight?: string;
      autoNamed?: boolean;
    },
  ) {
    return this.pipelinesService.updatePipeline(pipelineId, body);
  }

  @Post('pipelines/:pipelineId/duplicate')
  duplicatePipeline(
    @Param('pipelineId') pipelineId: string,
    @Body() body: { userId?: string; title?: string },
  ) {
    return this.pipelinesService.duplicatePipeline(pipelineId, body);
  }

  @Delete('pipelines/:pipelineId')
  deletePipeline(@Param('pipelineId') pipelineId: string) {
    return this.pipelinesService.deletePipeline(pipelineId);
  }

  @Post('pipelines/:pipelineId/modules')
  addModule(
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      moduleId?: string;
      afterModuleId?: string;
      layout?: Record<string, unknown>;
    },
  ) {
    return this.pipelinesService.addModule(pipelineId, {
      moduleId: body.moduleId,
      afterModuleId: body.afterModuleId,
      layout: body.layout,
    });
  }

  @Patch('pipelines/:pipelineId/modules/reorder')
  reorderModules(
    @Param('pipelineId') pipelineId: string,
    @Body() body: { moduleIds?: string[] },
  ) {
    return this.pipelinesService.reorderModules(pipelineId, body);
  }

  @Patch('pipelines/:pipelineId/modules/:moduleId/position')
  updateModulePosition(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { position?: { x?: number; y?: number } },
  ) {
    return this.pipelinesService.updateModulePosition(pipelineId, moduleId, body);
  }

  @Patch('pipelines/:pipelineId/connections')
  updateConnections(
    @Param('pipelineId') pipelineId: string,
    @Body() body: { connectedAfter?: string[] },
  ) {
    return this.pipelinesService.updateConnections(pipelineId, body);
  }

  @Post('pipelines/:pipelineId/connections/:moduleId/connect')
  connectAfter(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.connectAfter(pipelineId, moduleId);
  }

  @Delete('pipelines/:pipelineId/connections/:moduleId')
  disconnectAfter(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.disconnectAfter(pipelineId, moduleId);
  }

  @Delete('pipelines/:pipelineId/modules/:moduleId')
  removeModule(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.removeModule(pipelineId, moduleId);
  }

  @Get('pipelines/:pipelineId/module-snapshots')
  listModuleSnapshots(
    @Param('pipelineId') pipelineId: string,
    @Query('userId') userId?: string,
  ) {
    return this.pipelinesService.listModuleSnapshots(pipelineId, userId);
  }

  @Get('pipelines/:pipelineId/module-snapshots/:moduleId')
  getModuleSnapshot(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Query('userId') userId?: string,
  ) {
    return this.pipelinesService.getModuleSnapshot(pipelineId, moduleId, userId);
  }

  @Put('pipelines/:pipelineId/module-snapshots/:moduleId')
  saveModuleSnapshot(
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { userId?: string; summary?: string; data?: Record<string, unknown> | null },
  ) {
    return this.pipelinesService.saveModuleSnapshot(pipelineId, moduleId, body);
  }

  @Post('pipelines/:pipelineId/modules/search/collection-jobs')
  createSearchCollectionJob(
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      userId?: string;
      query?: string;
      kind?: 'dataset' | 'knowledge' | 'both';
      sources?: Array<'seed-catalog' | 'huggingface' | 'openml' | 'uci' | 'kaggle' | 'serpapi' | 'crossref'>;
      taskSignals?: Array<
        | 'classification'
        | 'regression'
        | 'anomaly-detection'
        | 'time-series-forecasting'
        | 'content-authenticity'
        | 'authorship-attribution'
      >;
      modalitySignals?: Array<'tabular' | 'text' | 'time-series' | 'transaction' | 'longitudinal' | 'document'>;
      mustInclude?: string[];
      mustAvoid?: string[];
      domainModuleId?: string;
    },
  ) {
    return this.pipelinesService.createSearchCollectionJob(pipelineId, body);
  }
}
