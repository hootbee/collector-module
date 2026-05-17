import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireUserId, resolveOptionalUserId, type MinimalRequest } from '../auth/auth-request';
import { PipelinesService } from './pipelines.service';

@Controller()
export class PipelinesController {
  private readonly logger = new Logger(PipelinesController.name);

  constructor(
    private readonly pipelinesService: PipelinesService,
    private readonly authService: AuthService,
  ) {}

  @Get('pipeline-templates')
  listSharedTemplates() {
    return this.pipelinesService.listSharedTemplates();
  }

  @Get('pipeline-templates/:templateId')
  getSharedTemplate(@Param('templateId') templateId: string) {
    return this.pipelinesService.getSharedTemplate(templateId);
  }

  @Post('pipeline-templates/:templateId/copy')
  async copySharedTemplate(
    @Req() request: MinimalRequest,
    @Param('templateId') templateId: string,
    @Body() body: { title?: string; isPublic?: boolean; is_public?: boolean },
  ) {
    const userId = await requireUserId(this.authService, request);
    return this.pipelinesService.copySharedTemplate(templateId, {
      userId,
      title: body.title,
      isPublic: body.isPublic ?? body.is_public,
    });
  }

  @Get('pipelines/public')
  listPublicPipelines() {
    return this.pipelinesService.listPublicPipelines();
  }

  @Get('pipelines')
  async listPipelines(@Req() request: MinimalRequest) {
    return this.pipelinesService.listPipelines(await resolveOptionalUserId(this.authService, request));
  }

  @Post('pipelines')
  async createPipeline(
    @Req() request: MinimalRequest,
    @Body()
    body: {
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
      isPublic?: boolean;
      is_public?: boolean;
      linkedDataSourceId?: string | null;
    },
  ) {
    return this.pipelinesService.createPipeline(await requireUserId(this.authService, request), {
      ...body,
      isPublic: body.isPublic ?? body.is_public,
    });
  }

  @Get('pipelines/:pipelineId')
  async getPipeline(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
  ) {
    return this.pipelinesService.getPipeline(pipelineId, await resolveOptionalUserId(this.authService, request));
  }

  @Patch('pipelines/:pipelineId')
  async updatePipeline(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      kind?: string;
      domainKey?: string;
      domainLabel?: string;
      title?: string;
      description?: string;
      highlight?: string;
      autoNamed?: boolean;
      isPublic?: boolean;
      is_public?: boolean;
      linkedDataSourceId?: string | null;
    },
  ) {
    const actorUserId = await requireUserId(this.authService, request);
    const normalizedIsPublic = body.isPublic ?? body.is_public;
    this.logger.log(
      `PATCH /pipelines/${pipelineId} actorUserId=${actorUserId} rawIsPublic=${String(body.isPublic)} rawIsPublicSnake=${String(body.is_public)} normalized=${String(normalizedIsPublic)}`,
    );
    return this.pipelinesService.updatePipeline(pipelineId, actorUserId, {
      ...body,
      isPublic: normalizedIsPublic,
    });
  }

  @Post('pipelines/:pipelineId/duplicate')
  async duplicatePipeline(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { title?: string },
  ) {
    return this.pipelinesService.duplicatePipeline(pipelineId, await requireUserId(this.authService, request), body);
  }

  @Delete('pipelines/:pipelineId')
  async deletePipeline(@Req() request: MinimalRequest, @Param('pipelineId') pipelineId: string) {
    return this.pipelinesService.deletePipeline(pipelineId, await requireUserId(this.authService, request));
  }

  @Post('pipelines/:pipelineId/modules')
  async addModule(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      moduleId?: string;
      afterModuleId?: string;
      layout?: Record<string, unknown>;
    },
  ) {
    return this.pipelinesService.addModule(pipelineId, {
      actorUserId: await requireUserId(this.authService, request),
      moduleId: body.moduleId,
      afterModuleId: body.afterModuleId,
      layout: body.layout,
    });
  }

  @Patch('pipelines/:pipelineId/modules/reorder')
  async reorderModules(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { moduleIds?: string[] },
  ) {
    return this.pipelinesService.reorderModules(
      pipelineId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Patch('pipelines/:pipelineId/modules/:moduleId/position')
  async updateModulePosition(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { position?: { x?: number; y?: number } },
  ) {
    return this.pipelinesService.updateModulePosition(
      pipelineId,
      await requireUserId(this.authService, request),
      moduleId,
      body,
    );
  }

  @Patch('pipelines/:pipelineId/connections')
  async updateConnections(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { connectedAfter?: string[] },
  ) {
    return this.pipelinesService.updateConnections(
      pipelineId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('pipelines/:pipelineId/connections/:moduleId/connect')
  async connectAfter(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.connectAfter(
      pipelineId,
      await requireUserId(this.authService, request),
      moduleId,
    );
  }

  @Delete('pipelines/:pipelineId/connections/:moduleId')
  async disconnectAfter(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.disconnectAfter(
      pipelineId,
      await requireUserId(this.authService, request),
      moduleId,
    );
  }

  @Delete('pipelines/:pipelineId/modules/:moduleId')
  async removeModule(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.removeModule(
      pipelineId,
      await requireUserId(this.authService, request),
      moduleId,
    );
  }

  @Get('pipelines/:pipelineId/module-snapshots')
  async listModuleSnapshots(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
  ) {
    return this.pipelinesService.listModuleSnapshots(
      pipelineId,
      await resolveOptionalUserId(this.authService, request),
    );
  }

  @Get('pipelines/:pipelineId/module-snapshots/:moduleId')
  async getModuleSnapshot(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return this.pipelinesService.getModuleSnapshot(
      pipelineId,
      moduleId,
      await resolveOptionalUserId(this.authService, request),
    );
  }

  @Put('pipelines/:pipelineId/module-snapshots/:moduleId')
  async saveModuleSnapshot(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { summary?: string; data?: Record<string, unknown> | null },
  ) {
    return this.pipelinesService.saveModuleSnapshot(
      pipelineId,
      moduleId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('pipelines/:pipelineId/modules/search/collection-jobs')
  async createSearchCollectionJob(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
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
    return this.pipelinesService.createSearchCollectionJob(
      pipelineId,
      await requireUserId(this.authService, request),
      body,
    );
  }
}
