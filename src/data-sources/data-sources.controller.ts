import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { requireUserId, resolveOptionalUserId, type MinimalRequest } from '../auth/auth-request';
import { DataSourcesService } from './data-sources.service';

@Controller('data-sources')
export class DataSourcesController {
  constructor(
    private readonly dataSourcesService: DataSourcesService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async list(@Req() request: MinimalRequest) {
    const userId = await resolveOptionalUserId(this.authService, request);
    return this.dataSourcesService.list(userId);
  }

  @Post()
  async create(
    @Req() request: MinimalRequest,
    @Body() body: Record<string, unknown>,
  ) {
    return this.dataSourcesService.create(await requireUserId(this.authService, request), body);
  }

  @Get(':dataSourceId')
  async get(@Req() request: MinimalRequest, @Param('dataSourceId') dataSourceId: string) {
    return this.dataSourcesService.get(dataSourceId, await resolveOptionalUserId(this.authService, request));
  }

  @Patch(':dataSourceId')
  async update(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.dataSourcesService.update(dataSourceId, await requireUserId(this.authService, request), body);
  }

  @Patch(':dataSourceId/linked-pipeline')
  async updateLinkedPipeline(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: { linkedPipelineId?: string | null },
  ) {
    return this.dataSourcesService.updateLinkedPipeline(
      dataSourceId,
      await requireUserId(this.authService, request),
      body.linkedPipelineId,
    );
  }

  @Patch(':dataSourceId/link-pipeline')
  async linkPipeline(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: { pipelineId?: string | null },
  ) {
    return this.dataSourcesService.updateLinkedPipeline(
      dataSourceId,
      await requireUserId(this.authService, request),
      body.pipelineId ?? null,
    );
  }

  @Post('upload')
  async uploadAsDataSource(
    @Req() request: MinimalRequest,
    @Body() body: { name?: string; source?: string; rowsLabel?: string | null; pipelineId?: string | null },
  ) {
    return this.dataSourcesService.createFromUpload(
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post('register-url')
  async registerUrlAsDataSource(
    @Req() request: MinimalRequest,
    @Body() body: { url?: string; name?: string; rowsLabel?: string | null; pipelineId?: string | null },
  ) {
    return this.dataSourcesService.createFromUrl(
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Post(':dataSourceId/pipeline')
  async createPipeline(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: { title?: string; isPublic?: boolean },
  ) {
    return this.dataSourcesService.createPipelineFromDataSource(
      dataSourceId,
      await requireUserId(this.authService, request),
      body,
    );
  }

  @Delete(':dataSourceId')
  async delete(@Req() request: MinimalRequest, @Param('dataSourceId') dataSourceId: string) {
    return this.dataSourcesService.delete(dataSourceId, await requireUserId(this.authService, request));
  }
}
