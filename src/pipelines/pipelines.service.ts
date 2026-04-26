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
    const connectedAfter = this.nextConnectedAfter(moduleIds, pipeline.connectedAfter, moduleId, input.afterModuleId);
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
    moduleId: string,
    afterModuleId?: string | null,
  ): string[] {
    const after = afterModuleId?.trim();
    const withoutTarget = current.filter((id) => id !== moduleId);
    if (!after || !moduleIds.includes(after)) {
      return withoutTarget;
    }
    return [...withoutTarget, moduleId];
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
}
