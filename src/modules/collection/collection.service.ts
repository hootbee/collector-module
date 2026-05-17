import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CollectionJobResultsResponse,
  CollectionJobStatusResponse,
  CollectionKind,
  CollectionSourceId,
  ModalitySignal,
  TaskSignal,
} from '../../common/contracts';
import { StoreService } from '../../store/store.service';
import { CollectionOrchestratorService } from './collection-orchestrator.service';

@Injectable()
export class CollectionService {
  private readonly enforceLlmPlanner = ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECTION_ENFORCE_LLM_PLANNER ?? 'false').trim().toLowerCase(),
  );

  constructor(
    private readonly storeService: StoreService,
    private readonly orchestratorService: CollectionOrchestratorService,
  ) {}

  async createJob(input: {
    query: string;
    kind: CollectionKind;
    requestedSources: CollectionSourceId[];
    taskSignals?: TaskSignal[];
    modalitySignals?: ModalitySignal[];
    mustInclude?: string[];
    mustAvoid?: string[];
  }): Promise<CollectionJobStatusResponse> {
    const job = await this.storeService.createCollectionJob({
      query: input.query,
      kind: input.kind,
      requestedSources: input.requestedSources,
      taskSignals: input.taskSignals ?? [],
      modalitySignals: input.modalitySignals ?? [],
    });

    void this.runJob({
      jobId: job.id,
      query: input.query,
      kind: input.kind,
      requestedSources: input.requestedSources,
      taskSignals: input.taskSignals ?? [],
      modalitySignals: input.modalitySignals ?? [],
      mustInclude: input.mustInclude ?? [],
      mustAvoid: input.mustAvoid ?? [],
    });

    return this.getStatus(job.id);
  }

  async getStatus(jobId: string): Promise<CollectionJobStatusResponse> {
    const status = await this.storeService.toCollectionJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Collection job ${jobId} was not found.`);
    }
    return status;
  }

  async getResults(jobId: string): Promise<CollectionJobResultsResponse> {
    const results = await this.storeService.toCollectionJobResults(jobId);
    if (!results) {
      throw new NotFoundException(`Collection job ${jobId} was not found.`);
    }
    const candidates = (results.datasetItems?.length ?? 0) + (results.knowledgeItems?.length ?? 0);
    const allScores = [
      ...(results.datasetItems ?? []).map((item) => Number(item.score)).filter((score) => Number.isFinite(score)),
      ...(results.knowledgeItems ?? []).map((item) => Number(item.score)).filter((score) => Number.isFinite(score)),
    ];
    const avgRelevanceScore = allScores.length > 0
      ? allScores.reduce((sum, score) => sum + score, 0) / allScores.length
      : 0;
    const usableCount =
      (results.datasetItems ?? []).filter((item) => Number(item.score) >= 0.65).length
      + (results.knowledgeItems ?? []).filter((item) => Number(item.score) >= 0.65).length;

    const insufficientReasons: string[] = [];
    if (candidates < 10) insufficientReasons.push('후보 수가 기준(10개)보다 적습니다.');
    if (usableCount < 3) insufficientReasons.push('유효 후보 수가 기준(3개)보다 적습니다.');
    if (avgRelevanceScore < 0.65) insufficientReasons.push('평균 관련도 점수가 기준(0.65)보다 낮습니다.');

    const evaluatedStatus = results.jobStatus === 'failed' || results.status === 'failed'
      ? 'FAILED'
      : insufficientReasons.length > 0
        ? 'INSUFFICIENT'
        : 'SUCCESS';

    return {
      ...results,
      jobStatus: (results as CollectionJobResultsResponse).jobStatus ?? (results as any).status,
      status: evaluatedStatus,
      metrics: {
        candidateCount: candidates,
        usableCount,
        avgRelevanceScore,
      },
      insufficientReasons,
      nextActionHint: 'UPLOAD_OR_REGISTER_URL',
    };
  }

  private async runJob(input: {
    jobId: string;
    query: string;
    kind: CollectionKind;
    requestedSources: CollectionSourceId[];
    taskSignals: TaskSignal[];
    modalitySignals: ModalitySignal[];
    mustInclude: string[];
    mustAvoid: string[];
  }) {
    try {
      const orchestration = await this.orchestratorService.execute({
        query: input.query,
        kind: input.kind,
        requestedSources: input.requestedSources,
        taskSignals: input.taskSignals,
        modalitySignals: input.modalitySignals,
        mustInclude: input.mustInclude,
        mustAvoid: input.mustAvoid,
      });

      if (this.enforceLlmPlanner) {
        if (!orchestration.llmPlan || !orchestration.llmPlanRaw) {
          throw new Error(
            'LLM planner enforcement is enabled, but llmPlan/llmPlanRaw is missing.',
          );
        }
      }

      await this.storeService.startCollectionJob(input.jobId, {
        stage: 'collecting',
        datasetQueries: orchestration.plan.datasetQueries,
        knowledgeQueries: orchestration.plan.knowledgeQueries,
        mustInclude: orchestration.plan.mustInclude,
        mustAvoid: orchestration.plan.mustAvoid,
        llmPlanRaw: orchestration.llmPlanRaw,
        llmPlan: orchestration.llmPlan,
      });

      console.info(
        `[CollectionService] collection context ${JSON.stringify({
          jobId: input.jobId,
          query: input.query,
          kind: input.kind,
          requestedSources: input.requestedSources,
          taskSignals: orchestration.context.taskSignals,
          modalitySignals: orchestration.context.modalitySignals,
          modality: orchestration.context.modality,
          datasetQueries: orchestration.plan.datasetQueries,
          knowledgeQueries: orchestration.plan.knowledgeQueries,
          mustInclude: orchestration.plan.mustInclude,
          mustAvoid: orchestration.plan.mustAvoid,
        })}`,
      );
      if (orchestration.llmPlan) {
        console.info(
          `[CollectionService] collection llm plan ${JSON.stringify({
            jobId: input.jobId,
            canonicalIntent: orchestration.llmPlan.canonicalIntent,
            taskSignals: orchestration.llmPlan.taskSignals,
            modalitySignals: orchestration.llmPlan.modalitySignals,
            notes: orchestration.llmPlan.notes,
          })}`,
        );
      }
      console.info(
        `[CollectionService] connector status ${JSON.stringify(orchestration.connectorStatuses)}`,
      );
      console.info(
        `[CollectionService] collection provenance ${JSON.stringify({
          jobId: input.jobId,
          routedHitCount: orchestration.routedHits.length,
          fetchedDocumentCount: orchestration.fetchedDocuments.length,
          genericKnowledgeCount: orchestration.rawKnowledgeHits.filter((hit) => hit.layer === 'generic').length,
          genericDatasetCount: orchestration.rawDatasetHits.filter((hit) => hit.layer === 'generic').length,
        })}`,
      );

      await this.storeService.completeCollectionJob(input.jobId, {
        connectorStatuses: orchestration.connectorStatuses,
        routedHits: orchestration.routedHits,
        fetchedDocuments: orchestration.fetchedDocuments,
        rawKnowledgeHits: orchestration.rawKnowledgeHits,
        rawDatasetHits: orchestration.rawDatasetHits,
        knowledgeItems: orchestration.knowledgeItems,
        datasetItems: orchestration.datasetItems,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown collection failure';
      await this.storeService.failCollectionJob(input.jobId, message);
    }
  }
}
