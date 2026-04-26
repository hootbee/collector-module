import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CollectionJobStatusResponse,
  CollectionSourceId,
  ModalitySignal,
  ModuleSnapshotListResponse,
  ModuleSnapshotResponse,
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
    });
    return { pipeline };
  }

  async listPipelines(userId?: string | null): Promise<{ pipelines: PipelineRecord[] }> {
    return {
      pipelines: await this.storeService.listPipelines(userId),
    };
  }

  async getPipeline(pipelineId: string): Promise<PipelineResponse> {
    return {
      pipeline: await this.loadPipeline(pipelineId),
    };
  }

  async createPipeline(input: {
    userId?: string | null;
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
  }): Promise<PipelineResponse> {
    const title = input.title?.trim();
    if (!title) {
      throw new BadRequestException('title is required.');
    }
    const userId = this.cleanOptional(input.userId);
    if (userId && !await this.storeService.getUser(userId)) {
      throw new BadRequestException(`User ${userId} was not found.`);
    }
    const moduleIds = this.cleanModuleIds(input.moduleIds);
    const connectedAfter = this.normalizeConnectedAfter(
      moduleIds,
      this.cleanModuleIds(input.connectedAfter),
    );
    const pipeline = await this.storeService.createPipeline({
      userId,
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
    });
    return { pipeline };
  }

  async updatePipeline(
    pipelineId: string,
    input: {
      userId?: string | null;
      kind?: string;
      domainKey?: string | null;
      domainLabel?: string | null;
      title?: string;
      description?: string;
      highlight?: string | null;
      autoNamed?: boolean;
    },
  ): Promise<PipelineResponse> {
    await this.loadPipeline(pipelineId);
    const patch: Partial<PipelineRecord> = {};
    if (input.userId !== undefined) {
      const userId = this.cleanOptional(input.userId);
      if (userId && !await this.storeService.getUser(userId)) {
        throw new BadRequestException(`User ${userId} was not found.`);
      }
      patch.userId = userId;
    }
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
    const pipeline = await this.storeService.updatePipeline(pipelineId, patch);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    return { pipeline };
  }

  async duplicatePipeline(pipelineId: string, input?: {
    userId?: string | null;
    title?: string;
  }): Promise<PipelineResponse> {
    const source = await this.loadPipeline(pipelineId);
    const userId = input?.userId !== undefined ? this.cleanOptional(input.userId) : source.userId;
    if (userId && !await this.storeService.getUser(userId)) {
      throw new BadRequestException(`User ${userId} was not found.`);
    }
    const pipeline = await this.storeService.createPipeline({
      userId,
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
    });
    return { pipeline };
  }

  async deletePipeline(pipelineId: string): Promise<{ status: 'ok' }> {
    const deleted = await this.storeService.deletePipeline(pipelineId);
    if (!deleted) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    return { status: 'ok' };
  }

  async addModule(pipelineId: string, input: {
    moduleId?: string;
    afterModuleId?: string | null;
    layout?: Record<string, unknown>;
  }): Promise<PipelineResponse> {
    const moduleId = input.moduleId?.trim();
    if (!moduleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId);
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

  async removeModule(pipelineId: string, moduleId: string): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId);
    const moduleIds = pipeline.moduleIds.filter((id) => id !== targetModuleId);
    const connectedAfter = pipeline.connectedAfter.filter((id) => id !== targetModuleId);
    const moduleLayout = Object.fromEntries(
      Object.entries(pipeline.moduleLayout).filter(([id]) => id !== targetModuleId),
    );
    return this.updateModules(pipeline.id, moduleIds, connectedAfter, moduleLayout);
  }

  async reorderModules(pipelineId: string, input: { moduleIds?: string[] }): Promise<PipelineResponse> {
    const requested = this.cleanModuleIds(input.moduleIds);
    if (requested.length === 0) {
      throw new BadRequestException('moduleIds is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId);
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
    const pipeline = await this.loadPipeline(pipelineId);
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
    input: { connectedAfter?: string[] },
  ): Promise<PipelineResponse> {
    const pipeline = await this.loadPipeline(pipelineId);
    const connectedAfter = this.normalizeConnectedAfter(
      pipeline.moduleIds,
      this.cleanModuleIds(input.connectedAfter),
    );
    return this.updateModules(pipeline.id, pipeline.moduleIds, connectedAfter, pipeline.moduleLayout);
  }

  async connectAfter(
    pipelineId: string,
    moduleId: string,
  ): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId);
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
    moduleId: string,
  ): Promise<PipelineResponse> {
    const targetModuleId = moduleId.trim();
    if (!targetModuleId) {
      throw new BadRequestException('moduleId is required.');
    }
    const pipeline = await this.loadPipeline(pipelineId);
    const connectedAfter = pipeline.connectedAfter.filter((id) => id !== targetModuleId);
    return this.updateModules(pipeline.id, pipeline.moduleIds, connectedAfter, pipeline.moduleLayout);
  }

  async listModuleSnapshots(pipelineId: string, userId?: string | null): Promise<ModuleSnapshotListResponse> {
    await this.loadPipeline(pipelineId);
    return {
      moduleSnapshots: await this.storeService.listModuleSnapshots({
        pipelineId,
        userId: userId === undefined ? undefined : this.cleanOptional(userId),
      }),
    };
  }

  async getModuleSnapshot(
    pipelineId: string,
    moduleId: string,
    userId?: string | null,
  ): Promise<ModuleSnapshotResponse> {
    await this.loadPipeline(pipelineId);
    const moduleSnapshot = await this.storeService.getModuleSnapshot({
      pipelineId,
      moduleId: moduleId.trim(),
      userId: userId === undefined ? undefined : this.cleanOptional(userId),
    });
    if (!moduleSnapshot) {
      throw new NotFoundException(`Module snapshot was not found for moduleId=${moduleId}.`);
    }
    return { moduleSnapshot };
  }

  async saveModuleSnapshot(
    pipelineId: string,
    moduleId: string,
    input: {
      userId?: string | null;
      summary?: string;
      data?: Record<string, unknown> | null;
    },
  ): Promise<ModuleSnapshotResponse> {
    await this.loadPipeline(pipelineId);
    const userId = this.cleanOptional(input.userId);
    if (userId && !await this.storeService.getUser(userId)) {
      throw new BadRequestException(`User ${userId} was not found.`);
    }
    return {
      moduleSnapshot: await this.storeService.saveModuleSnapshot({
        userId,
        pipelineId,
        moduleId: moduleId.trim(),
        summary: input.summary?.trim() || '',
        data: input.data && typeof input.data === 'object' && !Array.isArray(input.data)
          ? input.data
          : null,
      }),
    };
  }

  async createSearchCollectionJob(
    pipelineId: string,
    input: {
      userId?: string | null;
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
    await this.loadPipeline(pipelineId);
    const userId = this.cleanOptional(input.userId);
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

  private async loadPipeline(pipelineId: string): Promise<PipelineRecord> {
    const pipeline = await this.storeService.getPipeline(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} was not found.`);
    }
    return pipeline;
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
