import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSourceListResponse, DataSourceRecord, DataSourceResponse, PipelineResponse } from '../common/contracts';
import { DataSourceAnalysisService } from './data-source-analysis.service';
import { StoreService } from '../store/store.service';

type DataSourceInput = {
  userId?: string | null;
  name?: string;
  source?: string;
  rowsLabel?: string | null;
  linkedPipelineId?: string | null;
  domainIndustryContext?: string | null;
  domainSubjectScope?: string | null;
  domainRegulationScope?: string | null;
  domainStakeholderNotes?: string | null;
  dataModality?: string | null;
  rowUnit?: string | null;
  sensitivityNote?: string | null;
  targetColumn?: string | null;
  targetLabel?: string | null;
};

@Injectable()
export class DataSourcesService {
  constructor(
    private readonly storeService: StoreService,
    private readonly analysisService: DataSourceAnalysisService,
  ) {}

  async list(userId?: string | null): Promise<DataSourceListResponse> {
    if (!userId) {
      return {
        items: [],
        dataSources: [],
        authRequired: true,
        message: '로그인이 필요한 기능입니다.',
      };
    }
    const items = await this.storeService.listDataSources(this.cleanOptional(userId));
    return {
      items,
      dataSources: items,
      authRequired: false,
    };
  }

  async get(dataSourceId: string, actorUserId?: string | null): Promise<DataSourceResponse> {
    return {
      dataSource: await this.load(dataSourceId, actorUserId),
    };
  }

  async create(actorUserId: string, input: DataSourceInput): Promise<DataSourceResponse> {
    const name = input.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required.');
    }
    if (!await this.storeService.getUser(actorUserId)) {
      throw new BadRequestException(`User ${actorUserId} was not found.`);
    }
    const linkedPipelineId = this.cleanOptional(input.linkedPipelineId);
    await this.assertPipelineExists(linkedPipelineId);

    const dataSource = await this.storeService.createDataSource({
      userId: actorUserId,
      name,
      source: this.cleanOptional(input.source) ?? '미지정',
      rowsLabel: this.cleanOptional(input.rowsLabel),
      linkedPipelineId,
      domainIndustryContext: this.cleanOptional(input.domainIndustryContext),
      domainSubjectScope: this.cleanOptional(input.domainSubjectScope),
      domainRegulationScope: this.cleanOptional(input.domainRegulationScope),
      domainStakeholderNotes: this.cleanOptional(input.domainStakeholderNotes),
      dataModality: this.cleanOptional(input.dataModality),
      rowUnit: this.cleanOptional(input.rowUnit),
      sensitivityNote: this.cleanOptional(input.sensitivityNote),
      targetColumn: this.cleanOptional(input.targetColumn),
      targetLabel: this.cleanOptional(input.targetLabel),
    });
    return { dataSource };
  }

  async update(dataSourceId: string, actorUserId: string, input: DataSourceInput): Promise<DataSourceResponse> {
    await this.load(dataSourceId, actorUserId);
    const patch: Partial<DataSourceRecord> = {};
    patch.userId = actorUserId;
    if (input.name !== undefined) {
      const name = input.name?.trim();
      if (!name) {
        throw new BadRequestException('name cannot be empty.');
      }
      patch.name = name;
    }
    if (input.source !== undefined) patch.source = this.cleanOptional(input.source) ?? '미지정';
    if (input.rowsLabel !== undefined) patch.rowsLabel = this.cleanOptional(input.rowsLabel);
    if (input.linkedPipelineId !== undefined) {
      const linkedPipelineId = this.cleanOptional(input.linkedPipelineId);
      await this.assertPipelineExists(linkedPipelineId);
      patch.linkedPipelineId = linkedPipelineId;
    }
    if (input.domainIndustryContext !== undefined) patch.domainIndustryContext = this.cleanOptional(input.domainIndustryContext);
    if (input.domainSubjectScope !== undefined) patch.domainSubjectScope = this.cleanOptional(input.domainSubjectScope);
    if (input.domainRegulationScope !== undefined) patch.domainRegulationScope = this.cleanOptional(input.domainRegulationScope);
    if (input.domainStakeholderNotes !== undefined) patch.domainStakeholderNotes = this.cleanOptional(input.domainStakeholderNotes);
    if (input.dataModality !== undefined) patch.dataModality = this.cleanOptional(input.dataModality);
    if (input.rowUnit !== undefined) patch.rowUnit = this.cleanOptional(input.rowUnit);
    if (input.sensitivityNote !== undefined) patch.sensitivityNote = this.cleanOptional(input.sensitivityNote);
    if (input.targetColumn !== undefined) patch.targetColumn = this.cleanOptional(input.targetColumn);
    if (input.targetLabel !== undefined) patch.targetLabel = this.cleanOptional(input.targetLabel);

    const dataSource = await this.storeService.updateDataSource(dataSourceId, patch);
    if (!dataSource) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    return { dataSource };
  }

  async updateLinkedPipeline(
    dataSourceId: string,
    actorUserId: string,
    linkedPipelineId?: string | null,
  ): Promise<DataSourceResponse> {
    const current = await this.load(dataSourceId, actorUserId);
    const cleanPipelineId = this.cleanOptional(linkedPipelineId);
    await this.assertOwnedPipeline(cleanPipelineId, actorUserId);
    const dataSource = await this.storeService.updateDataSource(dataSourceId, {
      userId: actorUserId,
      linkedPipelineId: cleanPipelineId,
    });
    if (!dataSource) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    await this.syncPipelineDataLink(actorUserId, dataSourceId, current.linkedPipelineId, cleanPipelineId);
    return { dataSource };
  }

  async delete(dataSourceId: string, actorUserId: string): Promise<{ status: 'ok' }> {
    await this.load(dataSourceId, actorUserId);
    const deleted = await this.storeService.deleteDataSource(dataSourceId);
    if (!deleted) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    return { status: 'ok' };
  }

  async createPipelineFromDataSource(
    dataSourceId: string,
    actorUserId: string,
    input: { title?: string; isPublic?: boolean },
  ): Promise<PipelineResponse> {
    const dataSource = await this.load(dataSourceId, actorUserId);
    let highlight = `${dataSource.name} 데이터셋 기반 파이프라인입니다. 6단계 워크플로에서 부가 기능을 선택할 수 있습니다.`;
    try {
      const analysis = await this.analysisService.analyzeUploadedDataSource(dataSourceId);
      if (analysis.diagnosisSummary?.trim()) {
        highlight = analysis.diagnosisSummary.trim();
      }
    } catch {
      // 업로드 파일이 없거나 LLM 분석 실패 시 기본 한국어 요약 유지
    }

    const pipeline = await this.storeService.createPipeline({
      userId: actorUserId,
      kind: 'collection-workflow',
      domainKey: 'generic-data-collection',
      domainLabel: 'Generic Data Collection',
      title: input.title?.trim() || `${dataSource.name} 파이프라인`,
      description: `${dataSource.name} 데이터셋 기반으로 생성된 파이프라인입니다.`,
      moduleIds: ['diagnosis', 'domain', 'search', 'matching', 'synthesis', 'results'],
      connectedAfter: ['diagnosis', 'domain', 'search', 'matching', 'synthesis'],
      moduleLayout: {
        diagnosis: { x: 120, y: 120 },
        domain: { x: 320, y: 120 },
        search: { x: 520, y: 120 },
      },
      highlight,
      linkedDataSourceId: dataSourceId,
      autoNamed: false,
      isPublic: Boolean(input.isPublic),
    });

    await this.storeService.updateDataSource(dataSourceId, {
      userId: actorUserId,
      linkedPipelineId: pipeline.id,
    });

    return { pipeline: { ...pipeline, linkedDataSourceId: dataSourceId } };
  }

  async createFromUpload(
    actorUserId: string,
    input: {
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
      attachedFiles?: Array<{
        name?: string;
        size?: number;
        contentType?: string | null;
        buffer?: Buffer;
      }>;
    },
  ) {
    const uploadCandidates = Array.isArray(input.attachedFiles)
      ? input.attachedFiles.filter((file) => typeof file?.name === 'string' && file.name.trim())
      : [];
    const filesToStore = uploadCandidates
      .filter((file) => file.buffer && file.buffer.length > 0)
      .map((file) => ({
        fileName: String(file.name).trim(),
        contentType: file.contentType ?? null,
        content: file.buffer as Buffer,
      }));
    const fileSummary = uploadCandidates.length
      ? `[업로드 파일] ${uploadCandidates
        .map((file) => `${String(file.name).trim()} (${this.formatBytes(file.size)})`)
        .join('; ')}`
      : '';
    const stakeholderBase = this.cleanOptional(input.domainStakeholderNotes);
    const stakeholderNotes = [stakeholderBase, fileSummary].filter(Boolean).join('\n\n') || null;

    const created = await this.create(actorUserId, {
      name: input.name?.trim() || '사용자 업로드 데이터',
      source: input.source?.trim() || 'USER_UPLOAD',
      rowsLabel: input.rowsLabel ?? null,
      linkedPipelineId: input.pipelineId ?? null,
      domainIndustryContext: input.domainIndustryContext ?? null,
      domainSubjectScope: input.domainSubjectScope ?? null,
      domainRegulationScope: input.domainRegulationScope ?? null,
      domainStakeholderNotes: stakeholderNotes,
      dataModality: input.dataModality ?? null,
      rowUnit: input.rowUnit ?? null,
      sensitivityNote: input.sensitivityNote ?? null,
      targetColumn: input.targetColumn ?? null,
      targetLabel: input.targetLabel ?? null,
    });

    const storedFiles = await this.storeService.createDataSourceFiles(created.dataSource.id, filesToStore);
    let analysis = null;
    if (filesToStore.length > 0) {
      try {
        analysis = await this.analysisService.analyzeUploadedDataSource(created.dataSource.id);
        const enriched = await this.update(created.dataSource.id, actorUserId, {
          rowsLabel: analysis.rowsLabel ?? created.dataSource.rowsLabel,
          domainIndustryContext: analysis.domainIndustryContext,
          domainSubjectScope: analysis.domainSubjectScope,
          domainRegulationScope: analysis.domainRegulationScope,
          domainStakeholderNotes: [
            analysis.domainStakeholderNotes,
            analysis.diagnosisSummary ? `[LLM 진단] ${analysis.diagnosisSummary}` : '',
          ].filter(Boolean).join('\n\n') || null,
          dataModality: analysis.dataModality,
          rowUnit: analysis.rowUnit,
        });
        created.dataSource = enriched.dataSource;
      } catch {
        // 업로드 자체는 성공. 분석 실패는 별도 analyze API로 재시도 가능.
      }
    }

    return {
      dataSourceId: created.dataSource.id,
      sourceType: 'USER_UPLOAD' as const,
      linkedPipelineId: created.dataSource.linkedPipelineId,
      dataSource: created.dataSource,
      uploadedFiles: storedFiles.map((file) => ({
        id: file.id,
        name: file.fileName,
        size: file.bytes,
        contentType: file.contentType,
      })),
      analysis,
    };
  }

  async analyzeUploadedDataSource(dataSourceId: string, actorUserId: string) {
    await this.load(dataSourceId, actorUserId);
    const analysis = await this.analysisService.analyzeUploadedDataSource(dataSourceId);
    const updated = await this.update(dataSourceId, actorUserId, {
      rowsLabel: analysis.rowsLabel,
      domainIndustryContext: analysis.domainIndustryContext,
      domainSubjectScope: analysis.domainSubjectScope,
      domainRegulationScope: analysis.domainRegulationScope,
      domainStakeholderNotes: [
        analysis.domainStakeholderNotes,
        analysis.diagnosisSummary ? `[LLM 진단] ${analysis.diagnosisSummary}` : '',
      ].filter(Boolean).join('\n\n') || null,
      dataModality: analysis.dataModality,
      rowUnit: analysis.rowUnit,
    });
    return {
      analysis,
      dataSource: updated.dataSource,
    };
  }

  async previewDataSource(dataSourceId: string, actorUserId: string) {
    await this.load(dataSourceId, actorUserId);
    return this.analysisService.previewUploadedDataSource(dataSourceId);
  }

  async createFromUrl(
    actorUserId: string,
    input: { url?: string; name?: string; rowsLabel?: string | null; pipelineId?: string | null },
  ) {
    const url = this.cleanOptional(input.url);
    if (!url) {
      throw new BadRequestException('url is required.');
    }
    const created = await this.create(actorUserId, {
      name: input.name?.trim() || '사용자 URL 등록 데이터',
      source: `USER_URL:${url}`,
      rowsLabel: input.rowsLabel ?? null,
      linkedPipelineId: input.pipelineId ?? null,
    });
    return {
      dataSourceId: created.dataSource.id,
      sourceType: 'USER_URL' as const,
      linkedPipelineId: created.dataSource.linkedPipelineId,
      dataSource: created.dataSource,
    };
  }

  private async load(dataSourceId: string, actorUserId?: string | null): Promise<DataSourceRecord> {
    const dataSource = await this.storeService.getDataSource(dataSourceId);
    if (!dataSource) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    if (!actorUserId || dataSource.userId !== actorUserId) {
      throw new ForbiddenException('You do not have access to this data source.');
    }
    return dataSource;
  }

  private async assertPipelineExists(pipelineId?: string | null): Promise<void> {
    if (!pipelineId) {
      return;
    }
    if (!await this.storeService.getPipeline(pipelineId)) {
      throw new BadRequestException(`Pipeline ${pipelineId} was not found.`);
    }
  }

  private async assertOwnedPipeline(pipelineId: string | null, actorUserId: string): Promise<void> {
    if (!pipelineId) return;
    const pipeline = await this.storeService.getPipeline(pipelineId);
    if (!pipeline) {
      throw new BadRequestException(`Pipeline ${pipelineId} was not found.`);
    }
    if (pipeline.userId !== actorUserId) {
      throw new ForbiddenException('You can only link your own pipeline.');
    }
  }

  private async syncPipelineDataLink(
    actorUserId: string,
    dataSourceId: string,
    previousPipelineId: string | null,
    nextPipelineId: string | null,
  ): Promise<void> {
    const myPipelines = await this.storeService.listPipelines(actorUserId);
    const tasks: Array<Promise<unknown>> = [];

    // 기존 연결 해제
    if (previousPipelineId && previousPipelineId !== nextPipelineId) {
      const prev = myPipelines.find((p) => p.id === previousPipelineId);
      if (prev?.linkedDataSourceId === dataSourceId) {
        tasks.push(this.storeService.updatePipeline(previousPipelineId, { linkedDataSourceId: null }));
      }
    }

    // 같은 데이터소스를 물고 있는 다른 파이프라인 연결 해제(1:1 보장)
    for (const pipeline of myPipelines) {
      if (pipeline.id === nextPipelineId) continue;
      if (pipeline.linkedDataSourceId === dataSourceId) {
        tasks.push(this.storeService.updatePipeline(pipeline.id, { linkedDataSourceId: null }));
      }
    }

    // 신규 연결 반영
    if (nextPipelineId) {
      tasks.push(this.storeService.updatePipeline(nextPipelineId, { linkedDataSourceId: dataSourceId }));
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  private cleanOptional(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private formatBytes(value: unknown): string {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
