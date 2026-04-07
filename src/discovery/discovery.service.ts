import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DiscoveryJobResultsResponse,
  DiscoveryJobStatusResponse,
  DatasetRecord,
  DomainRecommendationResponse,
} from '../common/contracts';
import { sleep } from '../common/text';
import { DiscoveryOrchestratorService } from './discovery-orchestrator.service';
import { DomainRecommendationService } from '../domain-recommendation/domain-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly storeService: StoreService,
    private readonly profilingService: ProfilingService,
    private readonly recommendationService: DomainRecommendationService,
    private readonly discoveryOrchestratorService: DiscoveryOrchestratorService,
  ) {}

  async createJob(input: {
    datasetId: string;
    metadataColumns: string[];
    selectedDomains: string[];
  }): Promise<DiscoveryJobStatusResponse> {
    const dataset = this.storeService.getDataset(input.datasetId);
    if (!dataset) {
      throw new NotFoundException(`Dataset ${input.datasetId} was not found.`);
    }

    const analysis =
      dataset.analysis ?? this.storeService.setDatasetAnalysis(dataset.id, this.profilingService.analyzeDataset(dataset));
    const recommendation =
      dataset.recommendation ??
      this.storeService.setDatasetRecommendation(dataset.id, await this.recommendationService.recommendDataset({
        dataset,
        metadataColumns: input.metadataColumns,
      }));

    const selectedDomains =
      input.selectedDomains.length > 0
        ? [...input.selectedDomains]
        : recommendation.recommendedDomains.slice(0, 2).map((item) => item.name);

    const job = this.storeService.createJob({
      datasetId: dataset.id,
      sessionId: dataset.sessionId,
      selectedDomains,
      metadataColumns: input.metadataColumns.length > 0 ? input.metadataColumns : analysis.metadataCandidates,
    });

    void this.runJob({
      jobId: job.id,
      dataset,
      metadataColumns: job.metadataColumns,
      selectedDomains,
      recommendation,
    });

    return this.getStatus(job.id);
  }

  getStatus(jobId: string): DiscoveryJobStatusResponse {
    const status = this.storeService.toJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Discovery job ${jobId} was not found.`);
    }
    return status;
  }

  getResults(jobId: string): DiscoveryJobResultsResponse {
    const results = this.storeService.toJobResults(jobId);
    if (!results) {
      throw new NotFoundException(`Discovery job ${jobId} was not found.`);
    }
    return results;
  }

  private async runJob(input: {
    jobId: string;
    dataset: DatasetRecord;
    metadataColumns: string[];
    selectedDomains: string[];
    recommendation: DomainRecommendationResponse;
  }): Promise<void> {
    try {
      const context = this.recommendationService.buildDiscoveryContext({
        dataset: input.dataset,
        metadataColumns: input.metadataColumns,
        selectedDomains: input.selectedDomains,
      });
      const orchestration = await this.discoveryOrchestratorService.execute(context);
      const knowledgeConnectorSummary = this.connectorSummary(orchestration.knowledgeSearchDebug);
      const datasetConnectorSummary = this.connectorSummary(orchestration.datasetSearchDebug);

      this.storeService.startJob(input.jobId, {
        stage: 'query expansion',
        generatedQueries: orchestration.plan.datasetQueries,
        expandedKeywords: orchestration.plan.mustInclude,
      });

      console.info(
        `[DiscoveryService] discovery context ${JSON.stringify({
          jobId: input.jobId,
          datasetId: input.dataset.id,
          selectedDomains: context.selectedDomains,
          selectedDomainIds: context.selectedDomainIds,
          primaryDomainId: context.primaryDomainId,
          taskSignals: context.taskSignals,
          modalitySignals: context.modalitySignals,
          modality: context.modality,
          featureColumns: context.featureColumns,
          textColumns: context.textColumns,
          expandedKeywords: orchestration.plan.mustInclude,
          generatedQueries: orchestration.plan.datasetQueries,
          canonicalDatasetQueries: orchestration.plan.canonicalDatasetQueries,
          fallbackDatasetQueries: orchestration.plan.fallbackDatasetQueries,
          datasetSourceQueries: orchestration.plan.datasetSourceQueries,
          knowledgeQueries: orchestration.plan.knowledgeQueries,
          canonicalKnowledgeQueries: orchestration.plan.canonicalKnowledgeQueries,
          fallbackKnowledgeQueries: orchestration.plan.fallbackKnowledgeQueries,
          knowledgeSourceQueries: orchestration.plan.knowledgeSourceQueries,
          mustAvoid: orchestration.plan.mustAvoid,
        })}`,
      );
      console.info(
        `[DiscoveryService] connector summary ${JSON.stringify({
          jobId: input.jobId,
          datasetId: input.dataset.id,
          knowledge: knowledgeConnectorSummary,
          datasets: datasetConnectorSummary,
        })}`,
      );

      console.info(
        `[DiscoveryService] knowledge candidate hits ${JSON.stringify(orchestration.knowledgeSearchDebug)}`,
      );
      console.info(
        `[DiscoveryService] dataset candidate hits ${JSON.stringify(orchestration.datasetSearchDebug)}`,
      );
      console.info(
        `[DiscoveryService] knowledge ranking ${JSON.stringify(orchestration.knowledgeRankingDebug)}`,
      );
      console.info(
        `[DiscoveryService] dataset ranking ${JSON.stringify(orchestration.datasetRankingDebug)}`,
      );

      this.storeService.updateJobStage(input.jobId, 'streaming candidates');

      await Promise.all([
        this.streamKnowledge(input.jobId, orchestration.knowledgeItems),
        this.streamDatasets(input.jobId, orchestration.datasetItems),
      ]);

      this.storeService.completeJob(input.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown discovery failure';
      this.storeService.failJob(input.jobId, message);
    }
  }

  private connectorSummary(
    debugEntries: Array<{
      connector: string;
      status?: 'ok' | 'error';
      count?: number;
      error?: string;
    }>,
  ) {
    const grouped = new Map<
      string,
      {
        status: 'ok' | 'error';
        count: number;
        errors: string[];
      }
    >();

    for (const entry of debugEntries) {
      const current = grouped.get(entry.connector) ?? {
        status: 'ok',
        count: 0,
        errors: [],
      };
      current.count += entry.count ?? 0;
      if (entry.status === 'error') {
        current.status = 'error';
        if (entry.error) {
          current.errors.push(entry.error);
        }
      }
      grouped.set(entry.connector, current);
    }

    return [...grouped.entries()].map(([connector, summary]) => ({
      connector,
      status: summary.status,
      count: summary.count,
      errors: summary.errors.slice(0, 3),
    }));
  }

  private async streamKnowledge(
    jobId: string,
    items: DiscoveryJobResultsResponse['knowledgeItems'],
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      this.storeService.updateJobStage(jobId, `knowledge ${index + 1}/${items.length}`);
      await sleep(250);
      this.storeService.appendKnowledgeItem(jobId, item);
    }
  }

  private async streamDatasets(
    jobId: string,
    items: DiscoveryJobResultsResponse['datasetItems'],
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      this.storeService.updateJobStage(jobId, `dataset ${index + 1}/${items.length}`);
      await sleep(250);
      this.storeService.appendDatasetItem(jobId, item);
    }
  }
}
