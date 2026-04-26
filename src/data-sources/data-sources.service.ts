import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSourceListResponse, DataSourceRecord, DataSourceResponse } from '../common/contracts';
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
    return {
      dataSources: await this.storeService.listDataSources(this.cleanOptional(userId)),
    };
  }

  async get(dataSourceId: string): Promise<DataSourceResponse> {
    return {
      dataSource: await this.load(dataSourceId),
    };
  }

  async create(input: DataSourceInput): Promise<DataSourceResponse> {
    const name = input.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required.');
    }
    const userId = this.cleanOptional(input.userId);
    if (userId && !await this.storeService.getUser(userId)) {
      throw new BadRequestException(`User ${userId} was not found.`);
    }
    const linkedPipelineId = this.cleanOptional(input.linkedPipelineId);
    await this.assertPipelineExists(linkedPipelineId);

    const dataSource = await this.storeService.createDataSource({
      userId,
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

  async update(dataSourceId: string, input: DataSourceInput): Promise<DataSourceResponse> {
    await this.load(dataSourceId);
    const patch: Partial<DataSourceRecord> = {};
    if (input.userId !== undefined) {
      const userId = this.cleanOptional(input.userId);
      if (userId && !await this.storeService.getUser(userId)) {
        throw new BadRequestException(`User ${userId} was not found.`);
      }
      patch.userId = userId;
    }
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

  async updateLinkedPipeline(dataSourceId: string, linkedPipelineId?: string | null): Promise<DataSourceResponse> {
    const cleanPipelineId = this.cleanOptional(linkedPipelineId);
    await this.assertPipelineExists(cleanPipelineId);
    const dataSource = await this.storeService.updateDataSource(dataSourceId, {
      linkedPipelineId: cleanPipelineId,
    });
    if (!dataSource) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    return { dataSource };
  }

  async delete(dataSourceId: string): Promise<{ status: 'ok' }> {
    const deleted = await this.storeService.deleteDataSource(dataSourceId);
    if (!deleted) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
    }
    return { status: 'ok' };
  }

  private async load(dataSourceId: string): Promise<DataSourceRecord> {
    const dataSource = await this.storeService.getDataSource(dataSourceId);
    if (!dataSource) {
      throw new NotFoundException(`Data source ${dataSourceId} was not found.`);
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

  private cleanOptional(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
