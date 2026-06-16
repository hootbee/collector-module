import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Query, Req, StreamableFile } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireUserId, requireUserIdWithOptionalQueryToken, resolveOptionalUserId, type MinimalRequest } from '../auth/auth-request';
import { PipelinesService } from './pipelines.service';
import { AddonRecommendationService } from './addon-recommendation.service';
import { PipelineStepExecutionService } from './pipeline-step-execution.service';
import { PipelineSynthesisService } from './pipeline-synthesis.service';
import { PipelineMissingImputationService } from './pipeline-missing-imputation.service';
import { PipelineDiagnosisExecutionService } from './pipeline-diagnosis-execution.service';
import { PipelineDataMergeService } from './pipeline-data-merge.service';

@Controller()
export class PipelinesController {
  private readonly logger = new Logger(PipelinesController.name);

  constructor(
    private readonly pipelinesService: PipelinesService,
    private readonly addonRecommendationService: AddonRecommendationService,
    private readonly stepExecutionService: PipelineStepExecutionService,
    private readonly synthesisService: PipelineSynthesisService,
    private readonly imputationService: PipelineMissingImputationService,
    private readonly diagnosisExecutionService: PipelineDiagnosisExecutionService,
    private readonly mergeService: PipelineDataMergeService,
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

  @Post('pipelines/addon-recommendations')
  async recommendPipelineAddons(
    @Req() request: MinimalRequest,
    @Body()
    body: {
      dataSourceId?: string | null;
      analysis?: Record<string, unknown> | null;
      addons?: Array<{
        id: string;
        parentCoreModule: string;
        label: string;
        description: string;
      }>;
    },
  ) {
    return this.addonRecommendationService.recommendAddons(
      await requireUserId(this.authService, request),
      {
        dataSourceId: body.dataSourceId ?? null,
        analysis: body.analysis as never,
        addons: body.addons ?? [],
      },
    );
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

  @Patch('pipelines/:pipelineId/module-snapshots/:moduleId')
  async mergeModuleSnapshot(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { data?: Record<string, unknown> | null },
  ) {
    return this.pipelinesService.mergeModuleSnapshot(
      pipelineId,
      moduleId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('pipelines/:pipelineId/module-snapshots/:moduleId/upload-chunk')
  async uploadModuleSnapshotChunk(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body()
    body: {
      uploadId?: string;
      index?: number;
      totalChunks?: number;
      summary?: string;
      chunk?: string;
    },
  ) {
    return this.pipelinesService.uploadModuleSnapshotChunk(
      pipelineId,
      moduleId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('pipelines/:pipelineId/module-snapshots/:moduleId/upload-complete')
  async completeModuleSnapshotUpload(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: { uploadId?: string },
  ) {
    return this.pipelinesService.completeModuleSnapshotUpload(
      pipelineId,
      moduleId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('pipelines/:pipelineId/execute-step')
  async executePipelineStep(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      stepId?: string;
      dataSourceId?: string | null;
      analysis?: Record<string, unknown> | null;
      context?: Record<string, unknown> | null;
    },
  ) {
    return this.stepExecutionService.executeStep(
      await requireUserId(this.authService, request),
      {
        pipelineId,
        stepId: body.stepId ?? '',
        dataSourceId: body.dataSourceId ?? null,
        analysis: body.analysis as never,
        context: body.context ?? null,
      },
    );
  }

  @Post('pipelines/:pipelineId/diagnosis/impute')
  async runDiagnosisImputation(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Body()
    body: {
      dataSourceId?: string;
      analysis?: Record<string, unknown> | null;
    },
  ) {
    return this.diagnosisExecutionService.runImputationOnly(
      await requireUserId(this.authService, request),
      pipelineId,
      body.dataSourceId ?? '',
      body.analysis as never,
    );
  }

  @Get('pipelines/:pipelineId/diagnosis/artifacts/:artifactId/download')
  async downloadDiagnosisImputationArtifact(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('artifactId') artifactId: string,
    @Query('access_token') accessToken?: string,
  ): Promise<StreamableFile> {
    const userId = await requireUserIdWithOptionalQueryToken(this.authService, request, accessToken);
    const artifact = await this.imputationService.getArtifact(pipelineId, artifactId, userId);
    const content = await this.imputationService.readArtifactContent(artifact);
    return new StreamableFile(content, {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${artifact.fileName}"`,
    });
  }

  @Get('pipelines/:pipelineId/synthesis/artifacts/:artifactId/download')
  async downloadSynthesisArtifact(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('artifactId') artifactId: string,
    @Query('access_token') accessToken?: string,
  ): Promise<StreamableFile> {
    const userId = await requireUserIdWithOptionalQueryToken(this.authService, request, accessToken);
    const artifact = await this.synthesisService.getArtifact(pipelineId, artifactId, userId);
    const content = await this.synthesisService.readArtifactContent(artifact);
    return new StreamableFile(content, {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${artifact.fileName}"`,
    });
  }

  @Get('pipelines/:pipelineId/matching/merge/:artifactId/download')
  async downloadMatchingMergeArtifact(
    @Req() request: MinimalRequest,
    @Param('pipelineId') pipelineId: string,
    @Param('artifactId') artifactId: string,
    @Query('access_token') accessToken?: string,
  ): Promise<StreamableFile> {
    const userId = await requireUserIdWithOptionalQueryToken(this.authService, request, accessToken);
    const { artifact, content } = await this.mergeService.readArtifactContent(pipelineId, artifactId, userId);
    return new StreamableFile(Buffer.from(content, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${artifact.fileName}"`,
    });
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
