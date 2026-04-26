import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  PipelineRecord,
  PipelineResponse,
  PipelineTemplateListResponse,
  SharedPipelineTemplate,
} from '../common/contracts';
import { StoreService } from '../store/store.service';
import { sharedPipelineTemplates } from './shared-pipeline-templates';

@Injectable()
export class PipelinesService {
  constructor(private readonly storeService: StoreService) {}

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
}
