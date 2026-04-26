import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CollectionKind,
  CollectionSourceId,
  ModalitySignal,
  OrchestratorJobLogRecord,
  OrchestratorJobResultsResponse,
  OrchestratorJobStatusResponse,
  OrchestratorModuleType,
  TaskSignal,
} from '../common/contracts';
import { CollectionService } from '../modules/collection/collection.service';
import { StoreService } from '../store/store.service';
import { OrchestratorModuleRegistryService } from './orchestrator-module-registry.service';

const collectionKinds: CollectionKind[] = ['dataset', 'knowledge', 'both'];
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
export class OrchestratorService {
  constructor(
    private readonly storeService: StoreService,
    private readonly registry: OrchestratorModuleRegistryService,
    private readonly collectionService: CollectionService,
  ) {}

  listModules() {
    return {
      modules: this.registry.list(),
    };
  }

  async createJob(input: {
    userId?: string | null;
    pipelineId?: string | null;
    dataSourceId?: string | null;
    moduleType: OrchestratorModuleType;
    input?: Record<string, unknown>;
  }): Promise<OrchestratorJobStatusResponse> {
    const moduleSpec = this.registry.get(input.moduleType);
    if (!moduleSpec) {
      throw new BadRequestException(`Unsupported moduleType: ${input.moduleType}`);
    }
    const job = await this.storeService.createOrchestratorJob({
      userId: input.userId,
      pipelineId: input.pipelineId,
      dataSourceId: input.dataSourceId,
      moduleType: input.moduleType,
      input: input.input ?? {},
    });

    void this.runJob(job.id);
    const status = await this.storeService.toOrchestratorJobStatus(job.id);
    if (!status) {
      throw new NotFoundException(`Orchestrator job ${job.id} was not found.`);
    }
    return status;
  }

  async getStatus(jobId: string): Promise<OrchestratorJobStatusResponse> {
    const status = await this.storeService.toOrchestratorJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Orchestrator job ${jobId} was not found.`);
    }
    return status;
  }

  async getResults(jobId: string): Promise<OrchestratorJobResultsResponse> {
    const results = await this.storeService.toOrchestratorJobResults(jobId);
    if (!results) {
      throw new NotFoundException(`Orchestrator job ${jobId} was not found.`);
    }
    return results;
  }

  async getLogs(jobId: string): Promise<{ jobId: string; logs: OrchestratorJobLogRecord[] }> {
    await this.getStatus(jobId);
    return {
      jobId,
      logs: await this.storeService.getJobLogs(jobId),
    };
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.storeService.getOrchestratorJob(jobId);
    if (!job) {
      return;
    }
    try {
      await this.storeService.startOrchestratorJob(job.id, 'dispatching');
      await this.storeService.appendJobLog({
        jobId: job.id,
        jobType: 'orchestrator',
        level: 'info',
        message: 'module dispatch started',
        context: { moduleType: job.moduleType },
      });

      if (job.moduleType === 'collection') {
        await this.runCollectionModule(job.id, job.input);
        return;
      }

      await this.runStubModule(job.id, job.moduleType, job.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown orchestrator failure';
      await this.storeService.appendJobLog({
        jobId,
        jobType: 'orchestrator',
        level: 'error',
        message: 'module execution failed',
        context: { error: message },
      });
      await this.storeService.failOrchestratorJob(jobId, message);
    }
  }

  private async runCollectionModule(jobId: string, input: Record<string, unknown>): Promise<void> {
    const collectionInput = this.toCollectionInput(input);
    await this.storeService.startOrchestratorJob(jobId, 'collection.submitting');
    const collectionStatus = await this.collectionService.createJob(collectionInput);
    await this.storeService.appendJobLog({
      jobId,
      jobType: 'orchestrator',
      level: 'info',
      message: 'collection job submitted',
      context: {
        collectionJobId: collectionStatus.jobId,
        query: collectionStatus.query,
        requestedSources: collectionStatus.requestedSources,
      },
    });

    await this.storeService.startOrchestratorJob(jobId, 'collection.running');
    const finalStatus = await this.waitForCollection(collectionStatus.jobId);
    if (finalStatus.status === 'failed') {
      throw new Error(finalStatus.error ?? `Collection job ${collectionStatus.jobId} failed.`);
    }
    const results = await this.collectionService.getResults(collectionStatus.jobId);
    await this.storeService.completeOrchestratorJob(jobId, {
      stage: 'completed',
      resultSummary: {
        delegatedModule: 'collection',
        collectionJobId: results.jobId,
        collectionStatus: results.status,
        datasetCount: results.datasetItems.length,
        knowledgeCount: results.knowledgeItems.length,
        connectorStatuses: results.connectorStatuses,
      },
    });
    await this.storeService.appendJobLog({
      jobId,
      jobType: 'orchestrator',
      level: 'info',
      message: 'collection module completed',
      context: {
        collectionJobId: results.jobId,
        datasetCount: results.datasetItems.length,
        knowledgeCount: results.knowledgeItems.length,
      },
    });
  }

  private async runStubModule(
    jobId: string,
    moduleType: Exclude<OrchestratorModuleType, 'collection'>,
    input: Record<string, unknown>,
  ): Promise<void> {
    await this.storeService.startOrchestratorJob(jobId, `${moduleType}.running`);
    await this.storeService.appendJobLog({
      jobId,
      jobType: 'orchestrator',
      level: 'warn',
      message: 'stub module executed without domain implementation',
      context: { moduleType },
    });
    await this.storeService.completeOrchestratorJob(jobId, {
      stage: 'completed',
      resultSummary: {
        delegatedModule: moduleType,
        stub: true,
        inputKeys: Object.keys(input),
        note: 'Module execution is intentionally stubbed. Orchestrator lifecycle is verified.',
      },
    });
  }

  private async waitForCollection(collectionJobId: string) {
    const attempts = Number(process.env.ORCHESTRATOR_COLLECTION_WAIT_ATTEMPTS ?? 240);
    const waitMs = Number(process.env.ORCHESTRATOR_COLLECTION_WAIT_MS ?? 1000);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.collectionService.getStatus(collectionJobId);
      if (status.status === 'completed' || status.status === 'failed') {
        return status;
      }
      await this.sleep(waitMs);
    }
    throw new Error(`Collection job ${collectionJobId} did not finish before orchestrator timeout.`);
  }

  private toCollectionInput(input: Record<string, unknown>): {
    query: string;
    kind: CollectionKind;
    requestedSources: CollectionSourceId[];
    taskSignals: TaskSignal[];
    modalitySignals: ModalitySignal[];
    mustInclude: string[];
    mustAvoid: string[];
  } {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) {
      throw new BadRequestException('collection input.query is required.');
    }
    const kind = typeof input.kind === 'string' && collectionKinds.includes(input.kind as CollectionKind)
      ? input.kind as CollectionKind
      : 'both';
    const requestedSources = Array.isArray(input.sources)
      ? input.sources.filter((source): source is CollectionSourceId => (
          typeof source === 'string' && collectionSources.includes(source as CollectionSourceId)
        ))
      : collectionSources;
    return {
      query,
      kind,
      requestedSources: requestedSources.length > 0 ? requestedSources : collectionSources,
      taskSignals: this.stringArray(input.taskSignals) as TaskSignal[],
      modalitySignals: this.stringArray(input.modalitySignals) as ModalitySignal[],
      mustInclude: this.stringArray(input.mustInclude),
      mustAvoid: this.stringArray(input.mustAvoid),
    };
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
