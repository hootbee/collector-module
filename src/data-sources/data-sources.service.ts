import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSourceListResponse, DataSourceRecord, DataSourceResponse, PipelineResponse } from '../common/contracts';
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
};

@Injectable()
export class DataSourcesService {
  constructor(private readonly storeService: StoreService) {}

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
    const pipeline = await this.storeService.createPipeline({
      userId: actorUserId,
      kind: 'collection-workflow',
      domainKey: 'generic-data-collection',
      domainLabel: 'Generic Data Collection',
      title: input.title?.trim() || `${dataSource.name} 파이프라인`,
      description: `${dataSource.name} 데이터셋 기반으로 생성된 파이프라인입니다.`,
      moduleIds: ['collection'],
      connectedAfter: [],
      moduleLayout: {
        collection: { x: 120, y: 120 },
      },
      highlight: 'Collection module only. Analysis/diagnosis modules can be added later.',
      autoNamed: false,
      isPublic: Boolean(input.isPublic),
    });
    return { pipeline };
  }

  async createFromUpload(
    actorUserId: string,
    input: { name?: string; source?: string; rowsLabel?: string | null; pipelineId?: string | null },
  ) {
    const created = await this.create(actorUserId, {
      name: input.name?.trim() || '사용자 업로드 데이터',
      source: input.source?.trim() || 'USER_UPLOAD',
      rowsLabel: input.rowsLabel ?? null,
      linkedPipelineId: input.pipelineId ?? null,
    });
    return {
      dataSourceId: created.dataSource.id,
      sourceType: 'USER_UPLOAD' as const,
      linkedPipelineId: created.dataSource.linkedPipelineId,
      dataSource: created.dataSource,
    };
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
}
