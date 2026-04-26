import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { OrchestratorModuleType } from '../common/contracts';
import { OrchestratorModuleRegistryService } from './orchestrator-module-registry.service';
import { OrchestratorService } from './orchestrator.service';

@Controller('orchestrator')
export class OrchestratorController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly registry: OrchestratorModuleRegistryService,
  ) {}

  @Get('modules')
  listModules() {
    return this.orchestratorService.listModules();
  }

  @Post('jobs')
  createJob(
    @Body()
    body: {
      userId?: string;
      pipelineId?: string;
      dataSourceId?: string;
      moduleType?: string;
      input?: Record<string, unknown>;
    },
  ) {
    const moduleType = body.moduleType?.trim() ?? '';
    if (!this.registry.isSupported(moduleType)) {
      throw new BadRequestException(
        `moduleType must be one of: ${this.registry.list().map((module) => module.type).join(', ')}`,
      );
    }
    return this.orchestratorService.createJob({
      userId: this.optionalString(body.userId),
      pipelineId: this.optionalString(body.pipelineId),
      dataSourceId: this.optionalString(body.dataSourceId),
      moduleType: moduleType as OrchestratorModuleType,
      input: this.objectInput(body.input),
    });
  }

  @Get('jobs/:jobId')
  getJobStatus(@Param('jobId') jobId: string) {
    return this.orchestratorService.getStatus(jobId);
  }

  @Get('jobs/:jobId/results')
  getJobResults(@Param('jobId') jobId: string) {
    return this.orchestratorService.getResults(jobId);
  }

  @Get('jobs/:jobId/logs')
  getJobLogs(@Param('jobId') jobId: string) {
    return this.orchestratorService.getLogs(jobId);
  }

  private optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private objectInput(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }
}
