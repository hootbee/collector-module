import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';

const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
const UPLOAD_MAX_FILE_COUNT = 24;

type UploadedFilePayload = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};
import { AuthService } from '../auth/auth.service';
import { requireUserId, requireUserIdWithOptionalQueryToken, resolveOptionalUserId, type MinimalRequest } from '../auth/auth-request';
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

  @Get(':dataSourceId/preview')
  async preview(@Req() request: MinimalRequest, @Param('dataSourceId') dataSourceId: string) {
    return this.dataSourcesService.previewDataSource(
      dataSourceId,
      await requireUserId(this.authService, request),
    );
  }

  @Get(':dataSourceId/download')
  async download(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
    @Query('access_token') accessToken?: string,
  ): Promise<StreamableFile> {
    const userId = await requireUserIdWithOptionalQueryToken(this.authService, request, accessToken);
    const file = await this.dataSourcesService.downloadDataSource(dataSourceId, userId);
    const contentType = file.contentType || 'application/octet-stream';
    const encodedName = encodeURIComponent(file.fileName);
    return new StreamableFile(file.content, {
      type: contentType,
      disposition: `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodedName}`,
    });
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
  @UseInterceptors(FilesInterceptor('files', UPLOAD_MAX_FILE_COUNT, {
    limits: { fileSize: UPLOAD_MAX_FILE_BYTES },
  }))
  async uploadAsDataSource(
    @Req() request: MinimalRequest,
    @UploadedFiles() files: UploadedFilePayload[] = [],
    @Body() body: {
      name?: string;
      source?: string;
      rowsLabel?: string | null;
      pipelineId?: string | null;
      domainIndustryContext?: string | null;
      domainSubjectScope?: string | null;
      domainRegulationScope?: string | null;
      domainStakeholderNotes?: string | null;
      dataModality?: string | null;
      rowUnit?: string | null;
      sensitivityNote?: string | null;
      targetColumn?: string | null;
      targetLabel?: string | null;
    },
  ) {
    return this.dataSourcesService.createFromUpload(
      await requireUserId(this.authService, request),
      {
        ...body,
        attachedFiles: files
          .filter((file) => file?.buffer && file.buffer.length > 0)
          .map((file) => ({
            name: String(file.originalname ?? '').trim(),
            size: Number(file.size ?? 0),
            contentType: file.mimetype ?? null,
            buffer: file.buffer,
          })),
      },
    );
  }

  @Post(':dataSourceId/analyze')
  async analyzeUploadedDataSource(
    @Req() request: MinimalRequest,
    @Param('dataSourceId') dataSourceId: string,
  ) {
    return this.dataSourcesService.analyzeUploadedDataSource(
      dataSourceId,
      await requireUserId(this.authService, request),
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
