import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CollectionJobStatusResponse,
  CollectionSourceId,
  ModalitySignal,
  ModuleSnapshotListResponse,
  ModuleSnapshotResponse,
  PipelineListResponse,
  PipelineRecord,
  PipelineResponse,
  PipelineTemplateListResponse,
  SharedPipelineTemplate,
  TaskSignal,
} from '../common/contracts';
import { CollectionService } from '../modules/collection/collection.service';
import { StoreService } from '../store/store.service';
import { sharedPipelineTemplates } from './shared-pipeline-templates';

const collectionSources: CollectionSourceId[] = [
  'seed-catalog',
  'huggingface',
  'openml',
  'uci',
  'kaggle',
  'serpapi',
  'crossref',
];

@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);
  private readonly snapshotUploadSessions = new Map<string, {
    pipelineId: string;
    moduleId: string;
    userId: string;
    summary: string;
    totalChunks: number;
    chunks: string[];
    createdAt: number;
  }>();

  constructor(
    private readonly storeService: StoreService,
    private readonly collectionService: CollectionService,
  ) {}

  listSharedTemplates(): PipelineTemplateListResponse {
    return {
      templates: sharedPipelineTemplates.map((template) => this.cloneTemplate(template)),
    };
  }

  getSharedTemplate(templateId: string): { template: SharedPipelineTemplate } {
    const template = this.findTemplate(templateId);
    return {
      template: this.cloneTemplate(template),
    };
  }

  async copySharedTemplate(templateId: string, input: {
    userId?: string | null;
    title?: string;
    isPublic?: boolean;
  }): Promise<PipelineResponse> {
    const template = this.findTemplate(templateId);
    if (input.userId && !await this.storeService.getUser(input.userId)) {
      throw new BadRequestException(`User ${input.userId} was not found.`);
    }
    const pipeline = await this.storeService.createPipeline({
      userId: input.userId ?? null,
      kind: template.kind,
      domainKey: template.domainKey,
      domainLabel: template.domainLabel,
      title: input.title?.trim() || template.title,
      description: template.description,
      moduleIds: template.moduleIds,
      connectedAfter: template.connectedAfter,
      moduleLayout: template.moduleLayout,
      highlight: template.highlight,
      autoNamed: false,
      // MVP 정책: 공유 허브 복사본은 항상 private
      isPublic: false,
      visibilityLocked: true,
      linkedDataSourceId: null,
    });
    return { pipeline };
  }

  async listPublicPipelines(): Promise<PipelineListResponse> {
    const items = await this.storeService.listPublicPipelines();
    return {
      items,
      pipelines: items,
      authRequired: false,
    };
  }

  async listPipelines(userId?: string | null): Promise<PipelineListResponse> {
    if (!userId) {
      return {
        items: [],
        pipelines: [],
        authRequired: true,
        message: '로그인이 필요한 기능입니다.',
      };
    }
    const items = await this.storeService.listPipelines(userId);
    return {
      items,
      pipelines: items,
      authRequired: false,
    };
  }

  async getPipeline(pipelineId: string, actorUserId?: string | null): Promise<PipelineResponse> {
    return {
      pipeline: await this.loadPipeline(pipelineId, actorUserId),
    };
  }

  async createPipeline(actorUserId: string, input: {
    kind?: string;
    domainKey?: string | null;
    domainLabel?: string | null;
    title?: string;
    description?: string;
    moduleIds?: string[];
    connectedAfter?: string[];
    moduleLayout?: Record<string, unknown>;
    highlight?: string | null;
    autoNamed?: boolean;
    isPublic?: boolean;
    linkedDataSourceId?: string | null;
  }): Promise<PipelineResponse> {
    const title = input.title?.trim();
    if (!title) {
      throw new BadRequestException('title is required.');
    }
    if (!await this.storeService.getUser(actorUserId)) {
      throw new BadRequestException(`User ${actorUserId} was not found.`);
    }
    const moduleIds = this.cleanModuleIds(input.moduleIds);
    const linkedDataSourceId = await this.assertLinkedDataSourceOwner(
      actorUserId,
      input.linkedDataSourceId,
    );
    const connectedAfter = this.normalizeConnectedAfter(
      moduleIds,
      this.cleanModuleIds(input.connectedAfter),
    );
    const pipeline = await this.storeService.createPipeline({
      userId: actorUserId,
      kind: input.kind?.trim() || 'custom',
      domainKey: this.cleanOptional(input.domainKey),
      domainLabel: this.cleanOptional(input.domainLabel),
      title,
      description: input.description?.trim() || '',
      moduleIds,
      connectedAfter,
      moduleLayout: this.objectInput(input.moduleLayout),
      highlight: this.cleanOptional(input.highlight),
      autoNamed: Boolean(input.autoNamed),
      isPublic: this.parseOptionalBoolean(input.isPublic, 'isPublic') ?? false,
      visibilityLocked: false,
      linkedDataSourceId,
    });
    return { pipeline };
  }

  async updatePipeline(
    pipelineId: string,
    actorUserId: string,
    input: {
      kind?: string;
      domainKey?: string | null;
      domainLabel?: string | null;
      title?: string;
      description?: string;
      highlight?: string | null;
      autoNamed?: boolean;
      isPublic?: boolean;
      linkedDataSourceId?: string | null;
    },
  ): Promise<PipelineResponse> {
    const currentPipeline = await this.loadPipeline(pipelineId, actorUserId);
    const patch: Partial<PipelineRecord> = {};
    patch.userId = actorUserId;
    if (input.kind !== undefined) patch.kind = input.kind?.trim() || 'custom';
    if (input.domainKey !== undefined) patch.domainKey = this.cleanOptional(input.domainKey);
    if (input.domainLabel !== undefined) patch.domainLabel = this.cleanOptional(input.domainLabel);
    if (input.title !== undefined) {
      const title = input.title?.trim();
      if (!title) {
        throw new BadRequestException('title cannot be empty.');
      }
      patch.title = title;
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || '';
    if (input.highlight !== undefined) patch.highlight = this.cleanOptional(input.highlight);
    if (input.autoNamed !== undefined) patch.autoNamed = Boolean(input.autoNamed);
    if (input.linkedDataSourceId !== undefined) {
      patch.linkedDataSourceId = await this.assertLinkedDataSourceOwner(
        actorUserId,
        input.linkedDataSourceId,
      );
    }
    if (input.isPublic !== undefined) {
      const nextIsPublic = this.parseOptionalBoolean(input.isPublic, 'isPublic')!;
      if (currentPipeline.visibilityLocked && nextIsPublic) {
        throw new BadRequestException('공유 허브에서 복사한 파이프라인은 공개로 전환할 수 없습니다.');
      }
      if (!currentPipeline.visibilityLocked) {
        patch.isPublic = nextIsPublic;
        this.logger.log(
          `pipeline visibility patch requested pipelineId=${pipelineId} actorUserId=${actorUserId} requested=${patch.isPublic} current=${currentPipeline.isPublic}`,
        );
      }
    }
    const pipeline = await this.storeService.updatePipeline(pipelineId, patch);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    if (patch.isPublic !== undefined && currentPipeline.isPublic !== patch.isPublic) {
      this.logger.log(
        `pipeline visibility changed pipelineId=${pipelineId} actorUserId=${actorUserId} ${currentPipeline.isPublic} -> ${patch.isPublic}`,
      );
    }
    return { pipeline };
  }

  async duplicatePipeline(pipelineId: string, actorUserId: string, input?: {
    title?: string;
  }): Promise<PipelineResponse> {
    const source = await this.loadPipelineForDuplicate(pipelineId, actorUserId);
    const pipeline = await this.storeService.createPipeline({
      userId: actorUserId,
      kind: source.kind,
      domainKey: source.domainKey,
      domainLabel: source.domainLabel,
      title: input?.title?.trim() || `${source.title} (copy)`,
      description: source.description,
      moduleIds: [...source.moduleIds],
      connectedAfter: [...source.connectedAfter],
      moduleLayout: { ...source.moduleLayout },
      highlight: source.highlight,
      autoNamed: false,
      isPublic: false,
      visibilityLocked: source.userId !== actorUserId,
      linkedDataSourceId: null,
    });
    return { pipeline };
  }

  async deletePipeline(pipelineId: string, actorUserId: string): Promise<{ status: 'ok' }> {
    await this.loadPipeline(pipelineId, actorUserId);
    const deleted = await this.storeService.deletePipeline(pipelineId);
    if (!deleted) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    return { status: 'ok' };
  }

  async addModule(pipelineId: string, input: {
    actorUserId: string;
    moduleId?: string;
    afterModuleId?: string | null;
    layout?: Record<string, unknown>;
  }): Promise<PipelineResponse> {
    const moduleId = input.moduleId?.trim();
    if (!moduleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId, input.actorUserId);
    const moduleIds = pipeline.moduleIds.includes(moduleId)
      ? [...pipeline.moduleIds]
      : [...pipeline.moduleIds, moduleId];
    const connectedAfter = this.nextConnectedAfter(moduleIds, pipeline.connectedAfter, input.afterModuleId);
    const moduleLayout = {
      ...pipeline.moduleLayout,
      ...(input.layout ? { [moduleId]: input.layout } : {}),
    };
    return this.updateModules(pipeline.id, moduleIds, connectedAfter, moduleLayout);
  }

  async removeModule(pipelineId: string, actorUserId: string, moduleId: string): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    const moduleIds = pipeline.moduleIds.filter((id) => id !== targetModuleId);
    const connectedAfter = pipeline.connectedAfter.filter((id) => id !== targetModuleId);
    const moduleLayout = Object.fromEntries(
      Object.entries(pipeline.moduleLayout).filter(([id]) => id !== targetModuleId),
    );
    return this.updateModules(pipeline.id, moduleIds, connectedAfter, moduleLayout);
  }

  async reorderModules(
    pipelineId: string,
    actorUserId: string,
    input: { moduleIds?: string[] },
  ): Promise<PipelineResponse> {
    const requested = this.cleanModuleIds(input.moduleIds);
    if (requested.length === 0) {
      throw new BadRequestException('moduleIds is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    const sameSet =
      requested.length === pipeline.moduleIds.length &&
      requested.every((id) => pipeline.moduleIds.includes(id));
    if (!sameSet) {
      throw new BadRequestException('moduleIds must contain exactly the same module ids as the current pipeline.');
    }
    const connectedAfter = this.normalizeConnectedAfter(requested, pipeline.connectedAfter);
    const moduleLayout = this.reorderLayout(pipeline.moduleLayout, requested);
    return this.updateModules(pipeline.id, requested, connectedAfter, moduleLayout);
  }

  async updateModulePosition(
    pipelineId: string,
    actorUserId: string,
    moduleId: string,
    input: { position?: { x?: number; y?: number } },
  ): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const x = input.position?.x;
    const y = input.position?.y;
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new BadRequestException('position.x and position.y are required numbers.');
    }
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    if (!pipeline.moduleIds.includes(targetModuleId)) {
      throw new BadRequestException(`moduleId ${targetModuleId} is not in the pipeline.`);
    }
    return this.updateModules(pipeline.id, pipeline.moduleIds, pipeline.connectedAfter, {
      ...pipeline.moduleLayout,
      [targetModuleId]: { x, y },
    });
  }

  async updateConnections(
    pipelineId: string,
    actorUserId: string,
    input: { connectedAfter?: string[] },
  ): Promise<PipelineResponse> {
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    const connectedAfter = this.normalizeConnectedAfter(
      pipeline.moduleIds,
      this.cleanModuleIds(input.connectedAfter),
    );
    return this.updateModules(pipeline.id, pipeline.moduleIds, connectedAfter, pipeline.moduleLayout);
  }

  async connectAfter(
    pipelineId: string,
    actorUserId: string,
    moduleId: string,
  ): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    if (!pipeline.moduleIds.includes(targetModuleId)) {
      throw new BadRequestException(`moduleId ${targetModuleId} is not in the pipeline.`);
    }
    const connectedAfter = this.normalizeConnectedAfter(
      pipeline.moduleIds,
      [...pipeline.connectedAfter, targetModuleId],
    );
    return this.updateModules(pipeline.id, pipeline.moduleIds, connectedAfter, pipeline.moduleLayout);
  }

  async disconnectAfter(
    pipelineId: string,
    actorUserId: string,
    moduleId: string,
  ): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId, actorUserId);
    const connectedAfter = pipeline.connectedAfter.filter((id) => id !== targetModuleId);
    return this.updateModules(pipeline.id, pipeline.moduleIds, connectedAfter, pipeline.moduleLayout);
  }

  async listModuleSnapshots(pipelineId: string, userId?: string | null): Promise<ModuleSnapshotListResponse> {
    if (!userId) {
      return { moduleSnapshots: [] };
    }
    await this.loadPipeline(pipelineId, userId);
    return {
      moduleSnapshots: await this.storeService.listModuleSnapshots({
        pipelineId,
        userId: this.cleanOptional(userId),
      }),
    };
  }

  async getModuleSnapshot(
    pipelineId: string,
    moduleId: string,
    userId?: string | null,
  ): Promise<ModuleSnapshotResponse> {
    if (!userId) {
      throw new ForbiddenException('You do not have access to this module snapshot.');
    }
    await this.loadPipeline(pipelineId, userId);
    const moduleSnapshot = await this.storeService.getModuleSnapshot({
      pipelineId,
      moduleId: moduleId.trim(),
      userId: this.cleanOptional(userId),
    });
    return { moduleSnapshot: moduleSnapshot ?? null };
  }

  async saveModuleSnapshot(
    pipelineId: string,
    moduleId: string,
    actorUserId: string,
    input: {
      summary?: string;
      data?: Record<string, unknown> | null;
    },
  ): Promise<ModuleSnapshotResponse> {
    await this.loadPipeline(pipelineId, actorUserId);
    if (!await this.storeService.getUser(actorUserId)) {
      throw new BadRequestException(`User ${actorUserId} was not found.`);
    }
    return {
      moduleSnapshot: await this.storeService.saveModuleSnapshot({
        userId: actorUserId,
        pipelineId,
        moduleId: moduleId.trim(),
        summary: input.summary?.trim() || '',
        data: input.data && typeof input.data === 'object' && !Array.isArray(input.data)
          ? input.data
          : null,
      }),
    };
  }

  async mergeModuleSnapshot(
    pipelineId: string,
    moduleId: string,
    actorUserId: string,
    input: {
      data?: Record<string, unknown> | null;
    },
  ): Promise<ModuleSnapshotResponse> {
    await this.loadPipeline(pipelineId, actorUserId);
    const existing = await this.storeService.getModuleSnapshot({
      pipelineId,
      moduleId: moduleId.trim(),
      userId: actorUserId,
    });
    const mergedData = this.mergeSnapshotData(
      existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
        ? existing.data
        : {},
      input.data && typeof input.data === 'object' && !Array.isArray(input.data)
        ? input.data
        : {},
    );
    return {
      moduleSnapshot: await this.storeService.saveModuleSnapshot({
        userId: actorUserId,
        pipelineId,
        moduleId: moduleId.trim(),
        summary: existing?.summary ?? '',
        data: mergedData,
      }),
    };
  }

  async uploadModuleSnapshotChunk(
    pipelineId: string,
    moduleId: string,
    actorUserId: string,
    input: {
      uploadId?: string;
      index?: number;
      totalChunks?: number;
      summary?: string;
      chunk?: string;
    },
  ): Promise<{ status: 'ok'; received: number; totalChunks: number }> {
    await this.loadPipeline(pipelineId, actorUserId);
    const uploadId = input.uploadId?.trim();
    const index = input.index;
    const totalChunks = input.totalChunks;
    const chunk = input.chunk ?? '';
    if (!uploadId || typeof index !== 'number' || typeof totalChunks !== 'number' || totalChunks < 1) {
      throw new BadRequestException('uploadId, index, totalChunks are required.');
    }
    if (index < 0 || index >= totalChunks) {
      throw new BadRequestException('chunk index is out of range.');
    }

    const sessionKey = `${actorUserId}:${pipelineId}:${moduleId.trim()}:${uploadId}`;
    let session = this.snapshotUploadSessions.get(sessionKey);
    if (!session) {
      session = {
        pipelineId,
        moduleId: moduleId.trim(),
        userId: actorUserId,
        summary: input.summary?.trim() || '',
        totalChunks,
        chunks: Array.from({ length: totalChunks }, () => ''),
        createdAt: Date.now(),
      };
      this.snapshotUploadSessions.set(sessionKey, session);
    } else if (session.totalChunks !== totalChunks) {
      throw new BadRequestException('totalChunks does not match the active upload session.');
    }

    if (index === 0 && input.summary?.trim()) {
      session.summary = input.summary.trim();
    }
    session.chunks[index] = chunk;
    this.cleanupSnapshotUploadSessions();
    return { status: 'ok', received: index + 1, totalChunks };
  }

  async completeModuleSnapshotUpload(
    pipelineId: string,
    moduleId: string,
    actorUserId: string,
    input: { uploadId?: string },
  ): Promise<ModuleSnapshotResponse> {
    await this.loadPipeline(pipelineId, actorUserId);
    const uploadId = input.uploadId?.trim();
    if (!uploadId) {
      throw new BadRequestException('uploadId is required.');
    }
    const sessionKey = `${actorUserId}:${pipelineId}:${moduleId.trim()}:${uploadId}`;
    const session = this.snapshotUploadSessions.get(sessionKey);
    if (!session) {
      throw new BadRequestException('upload session was not found or expired.');
    }
    if (session.chunks.some((part) => !part)) {
      throw new BadRequestException('not all chunks were uploaded.');
    }

    let parsed: { summary?: string; data?: Record<string, unknown> | null };
    try {
      parsed = JSON.parse(session.chunks.join('')) as { summary?: string; data?: Record<string, unknown> | null };
    } catch {
      throw new BadRequestException('uploaded snapshot payload is not valid JSON.');
    }

    this.snapshotUploadSessions.delete(sessionKey);
    return {
      moduleSnapshot: await this.storeService.saveModuleSnapshot({
        userId: actorUserId,
        pipelineId,
        moduleId: moduleId.trim(),
        summary: parsed.summary?.trim() || session.summary || '',
        data: parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
          ? parsed.data
          : null,
      }),
    };
  }

  private mergeSnapshotData(
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...base };

    if (Array.isArray(patch.subTaskResults)) {
      const existing = Array.isArray(result.subTaskResults)
        ? result.subTaskResults as Array<Record<string, unknown>>
        : [];
      const byId = new Map(existing.map((item) => [String(item.id ?? item.label ?? ''), item]));
      for (const item of patch.subTaskResults) {
        if (!item || typeof item !== 'object') continue;
        const key = String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).label ?? '');
        byId.set(key, item as Record<string, unknown>);
      }
      result.subTaskResults = [...byId.values()];
    }

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'subTaskResults') continue;
      if (
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && result[key]
        && typeof result[key] === 'object'
        && !Array.isArray(result[key])
      ) {
        result[key] = this.mergeSnapshotData(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private cleanupSnapshotUploadSessions(): void {
    const ttlMs = 15 * 60 * 1000;
    const now = Date.now();
    for (const [key, session] of this.snapshotUploadSessions.entries()) {
      if (now - session.createdAt > ttlMs) {
        this.snapshotUploadSessions.delete(key);
      }
    }
  }

  async createSearchCollectionJob(
    pipelineId: string,
    actorUserId: string,
    input: {
      query?: string;
      kind?: 'dataset' | 'knowledge' | 'both';
      sources?: CollectionSourceId[];
      taskSignals?: TaskSignal[];
      modalitySignals?: ModalitySignal[];
      mustInclude?: string[];
      mustAvoid?: string[];
      domainModuleId?: string;
    },
  ): Promise<{ collectionJob: CollectionJobStatusResponse; querySource: 'input' | 'domain-snapshot' | 'fallback' }> {
    await this.loadPipeline(pipelineId, actorUserId);
    const userId = actorUserId;
    const domainModuleId = input.domainModuleId?.trim() || 'domain';
    const domainSnapshot = await this.storeService.getModuleSnapshot({
      pipelineId,
      moduleId: domainModuleId,
      userId: userId ?? undefined,
    });

    const queryFromInput = input.query?.trim();
    const queryFromDomain = this.queryFromDomainSnapshot(domainSnapshot?.data ?? null);
    const query = queryFromInput || queryFromDomain || `pipeline ${pipelineId} dataset discovery`;
    const querySource = queryFromInput ? 'input' : queryFromDomain ? 'domain-snapshot' : 'fallback';

    const requestedSources = Array.isArray(input.sources) && input.sources.length > 0
      ? input.sources.filter((source): source is CollectionSourceId => collectionSources.includes(source))
      : collectionSources;
    if (requestedSources.length === 0) {
      throw new BadRequestException('sources must include at least one valid source.');
    }

    const taskSignals = Array.isArray(input.taskSignals)
      ? input.taskSignals.filter((item): item is TaskSignal => typeof item === 'string')
      : this.taskSignalsFromDomainSnapshot(domainSnapshot?.data ?? null);
    const modalitySignals = Array.isArray(input.modalitySignals)
      ? input.modalitySignals.filter((item): item is ModalitySignal => typeof item === 'string')
      : this.modalitySignalsFromDomainSnapshot(domainSnapshot?.data ?? null);

    const collectionJob = await this.collectionService.createJob({
      query,
      kind: input.kind ?? 'both',
      requestedSources,
      taskSignals,
      modalitySignals,
      mustInclude: this.stringArray(input.mustInclude),
      mustAvoid: this.stringArray(input.mustAvoid),
    });
    return { collectionJob, querySource };
  }

  private async updateModules(
    pipelineId: string,
    moduleIds: string[],
    connectedAfter: string[],
    moduleLayout: Record<string, unknown>,
  ): Promise<PipelineResponse> {
    const pipeline = await this.storeService.updatePipelineModules(pipelineId, {
      moduleIds,
      connectedAfter,
      moduleLayout,
    });
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    return { pipeline };
  }

  private nextConnectedAfter(
    moduleIds: string[],
    current: string[],
    afterModuleId?: string | null,
  ): string[] {
    const after = afterModuleId?.trim();
    if (!after || !moduleIds.includes(after)) {
      return this.normalizeConnectedAfter(moduleIds, current);
    }
    return this.normalizeConnectedAfter(moduleIds, [...current, after]);
  }

  private async loadPipeline(pipelineId: string, actorUserId?: string | null): Promise<PipelineRecord> {
    const pipeline = await this.storeService.getPipeline(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    if (!actorUserId || pipeline.userId !== actorUserId) {
      throw new ForbiddenException('You do not have access to this pipeline.');
    }
    return pipeline;
  }

  private async loadPipelineForDuplicate(pipelineId: string, actorUserId: string): Promise<PipelineRecord> {
    const pipeline = await this.storeService.getPipeline(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    if (pipeline.userId === actorUserId) {
      return pipeline;
    }
    if (pipeline.isPublic === true) {
      return pipeline;
    }
    throw new ForbiddenException('You do not have access to this pipeline.');
  }

  private async assertLinkedDataSourceOwner(
    actorUserId: string,
    linkedDataSourceId?: string | null,
  ): Promise<string | null> {
    const id = this.cleanOptional(linkedDataSourceId);
    if (!id) return null;
    const source = await this.storeService.getDataSource(id);
    if (!source) {
      throw new BadRequestException(`linkedDataSourceId ${id} was not found.`);
    }
    if (source.userId !== actorUserId) {
      throw new ForbiddenException('You can only link your own data source.');
    }
    return id;
  }

  private findTemplate(templateId: string): SharedPipelineTemplate {
    const template = sharedPipelineTemplates.find((item) => item.id === templateId);
    if (!template) {
      throw new NotFoundException(`Shared pipeline template ${templateId} was not found.`);
    }
    return template;
  }

  private cloneTemplate(template: SharedPipelineTemplate): SharedPipelineTemplate {
    return {
      ...template,
      moduleIds: [...template.moduleIds],
      connectedAfter: [...template.connectedAfter],
      moduleLayout: { ...template.moduleLayout },
    };
  }

  private cleanOptional(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  private cleanModuleIds(value?: string[]): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const result: string[] = [];
    value.forEach((item) => {
      if (typeof item !== 'string') {
        return;
      }
      const normalized = item.trim();
      if (!normalized || result.includes(normalized)) {
        return;
      }
      result.push(normalized);
    });
    return result;
  }

  private normalizeConnectedAfter(moduleIds: string[], connectedAfter: string[]): string[] {
    const lookup = new Set(moduleIds);
    return connectedAfter.filter((moduleId, index, all) => (
      lookup.has(moduleId) && all.indexOf(moduleId) === index
    ));
  }

  private objectInput(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private reorderLayout(layout: Record<string, unknown>, moduleIds: string[]): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(layout).filter(([moduleId]) => moduleIds.includes(moduleId)),
    );
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  }

  private queryFromDomainSnapshot(data: Record<string, unknown> | null): string | null {
    if (!data) {
      return null;
    }
    const parts = [
      this.valueFromSnapshot(data, 'industry'),
      this.valueFromSnapshot(data, 'subdomain'),
      this.valueFromSnapshot(data, 'ml_task'),
      this.valueFromSnapshot(data, 'target_event'),
      this.valueFromSnapshot(data, 'data_modality'),
      this.valueFromSnapshot(data, 'row_unit'),
    ].filter((item): item is string => Boolean(item));
    if (parts.length === 0) {
      return null;
    }
    return parts.join(' ');
  }

  private taskSignalsFromDomainSnapshot(data: Record<string, unknown> | null): TaskSignal[] {
    const mlTask = this.valueFromSnapshot(data, 'ml_task')?.toLowerCase() ?? '';
    if (mlTask.includes('regression')) return ['regression'];
    if (mlTask.includes('anomaly')) return ['anomaly-detection'];
    if (mlTask.includes('forecast')) return ['time-series-forecasting'];
    return mlTask ? ['classification'] : [];
  }

  private modalitySignalsFromDomainSnapshot(data: Record<string, unknown> | null): ModalitySignal[] {
    const modality = this.valueFromSnapshot(data, 'data_modality')?.toLowerCase() ?? '';
    if (modality.includes('text') || modality.includes('문서')) return ['text'];
    if (modality.includes('time') || modality.includes('시계열')) return ['time-series'];
    if (modality.includes('transaction') || modality.includes('거래')) return ['transaction'];
    if (modality.includes('longitudinal') || modality.includes('장기')) return ['longitudinal'];
    if (modality.includes('table') || modality.includes('테이블') || modality.includes('tabular')) return ['tabular'];
    return modality ? ['document'] : [];
  }

  private valueFromSnapshot(data: Record<string, unknown> | null, key: string): string | null {
    if (!data) {
      return null;
    }
    const value = data[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
