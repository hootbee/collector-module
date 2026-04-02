import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogConnectorsService } from '../connectors/catalog.connectors';
import type {
  DiscoveryJobResultsResponse,
  DiscoveryJobStatusResponse,
  DatasetRecord,
  DomainRecommendationResponse,
} from '../common/contracts';
import { sleep } from '../common/text';
import { DomainRecommendationService } from '../domain-recommendation/domain-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';
import { StoreService } from '../store/store.service';

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly storeService: StoreService,
    private readonly profilingService: ProfilingService,
    private readonly recommendationService: DomainRecommendationService,
    private readonly connectorsService: CatalogConnectorsService,
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

      this.storeService.startJob(input.jobId, {
        stage: 'query expansion',
        generatedQueries: context.generatedQueries,
        expandedKeywords: context.expandedKeywords,
      });

      const [knowledgeItems, datasetItems] = await Promise.all([
        Promise.resolve(this.connectorsService.searchKnowledge(context)),
        Promise.resolve(this.connectorsService.searchDatasets(context)),
      ]);

      this.storeService.updateJobStage(input.jobId, 'streaming candidates');

      await Promise.all([
        this.streamKnowledge(input.jobId, knowledgeItems),
        this.streamDatasets(input.jobId, datasetItems),
      ]);

      this.storeService.completeJob(input.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown discovery failure';
      this.storeService.failJob(input.jobId, message);
    }
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
