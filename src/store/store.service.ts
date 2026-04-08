import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CollectionConnectorStatus,
  CollectionDownloadItemResult,
  CollectionDownloadJobRecord,
  CollectionDownloadJobResultsResponse,
  CollectionDownloadJobStatusResponse,
  CollectionJobRecord,
  CollectionJobResultsResponse,
  CollectionJobStatusResponse,
  CollectionKind,
  CollectionLlmPlan,
  CollectionSourceId,
} from '../common/contracts';
import { nowIso } from '../common/time';

@Injectable()
export class StoreService {
  private readonly collectionJobs = new Map<string, CollectionJobRecord>();
  private readonly collectionDownloadJobs = new Map<string, CollectionDownloadJobRecord>();

  createCollectionJob(input: {
    query: string;
    kind: CollectionKind;
    requestedSources: CollectionSourceId[];
    taskSignals: CollectionJobRecord['taskSignals'];
    modalitySignals: CollectionJobRecord['modalitySignals'];
  }): CollectionJobRecord {
    const job: CollectionJobRecord = {
      id: `collection-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      query: input.query,
      kind: input.kind,
      requestedSources: [...input.requestedSources],
      taskSignals: [...input.taskSignals],
      modalitySignals: [...input.modalitySignals],
      status: 'queued',
      stage: 'waiting',
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      error: null,
      datasetQueries: [],
      knowledgeQueries: [],
      mustInclude: [],
      mustAvoid: [],
      llmPlanRaw: null,
      llmPlan: null,
      connectorStatuses: [],
      routedHits: [],
      fetchedDocuments: [],
      rawKnowledgeHits: [],
      rawDatasetHits: [],
      knowledgeItems: [],
      datasetItems: [],
    };

    this.collectionJobs.set(job.id, job);
    return job;
  }

  getCollectionJob(jobId: string): CollectionJobRecord | undefined {
    return this.collectionJobs.get(jobId);
  }

  startCollectionJob(jobId: string, payload: {
    stage: string;
    datasetQueries: string[];
    knowledgeQueries: string[];
    mustInclude: string[];
    mustAvoid: string[];
    llmPlanRaw?: string | null;
    llmPlan?: CollectionLlmPlan | null;
  }): void {
    const job = this.collectionJobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'running';
    job.stage = payload.stage;
    job.startedAt = nowIso();
    job.datasetQueries = [...payload.datasetQueries];
    job.knowledgeQueries = [...payload.knowledgeQueries];
    job.mustInclude = [...payload.mustInclude];
    job.mustAvoid = [...payload.mustAvoid];
    job.llmPlanRaw = payload.llmPlanRaw ?? null;
    job.llmPlan = payload.llmPlan ?? null;
  }

  completeCollectionJob(jobId: string, payload: {
    stage?: string;
    connectorStatuses: CollectionConnectorStatus[];
    routedHits: CollectionJobRecord['routedHits'];
    fetchedDocuments: CollectionJobRecord['fetchedDocuments'];
    rawKnowledgeHits: CollectionJobRecord['rawKnowledgeHits'];
    rawDatasetHits: CollectionJobRecord['rawDatasetHits'];
    knowledgeItems: CollectionJobRecord['knowledgeItems'];
    datasetItems: CollectionJobRecord['datasetItems'];
  }): void {
    const job = this.collectionJobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'completed';
    job.stage = payload.stage ?? 'completed';
    job.connectorStatuses = [...payload.connectorStatuses];
    job.routedHits = [...payload.routedHits];
    job.fetchedDocuments = [...payload.fetchedDocuments];
    job.rawKnowledgeHits = [...payload.rawKnowledgeHits];
    job.rawDatasetHits = [...payload.rawDatasetHits];
    job.knowledgeItems = [...payload.knowledgeItems];
    job.datasetItems = [...payload.datasetItems];
    job.completedAt = nowIso();
  }

  failCollectionJob(jobId: string, error: string): void {
    const job = this.collectionJobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'failed';
    job.stage = 'failed';
    job.error = error;
    job.completedAt = nowIso();
  }

  toCollectionJobStatus(jobId: string): CollectionJobStatusResponse | undefined {
    const job = this.collectionJobs.get(jobId);
    if (!job) {
      return undefined;
    }
    return {
      jobId: job.id,
      query: job.query,
      kind: job.kind,
      requestedSources: [...job.requestedSources],
      status: job.status,
      stage: job.stage,
      rawKnowledgeCount: job.rawKnowledgeHits.length,
      rawDatasetCount: job.rawDatasetHits.length,
      knowledgeCount: job.knowledgeItems.length,
      datasetCount: job.datasetItems.length,
      connectorStatuses: [...job.connectorStatuses],
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  toCollectionJobResults(jobId: string): CollectionJobResultsResponse | undefined {
    const job = this.collectionJobs.get(jobId);
    if (!job) {
      return undefined;
    }
    return {
      jobId: job.id,
      query: job.query,
      kind: job.kind,
      requestedSources: [...job.requestedSources],
      status: job.status,
      stage: job.stage,
      datasetQueries: [...job.datasetQueries],
      knowledgeQueries: [...job.knowledgeQueries],
      mustInclude: [...job.mustInclude],
      mustAvoid: [...job.mustAvoid],
      llmPlanRaw: job.llmPlanRaw,
      llmPlan: job.llmPlan,
      connectorStatuses: [...job.connectorStatuses],
      routedHits: [...job.routedHits],
      fetchedDocuments: [...job.fetchedDocuments],
      rawKnowledgeHits: [...job.rawKnowledgeHits],
      rawDatasetHits: [...job.rawDatasetHits],
      knowledgeItems: [...job.knowledgeItems],
      datasetItems: [...job.datasetItems],
    };
  }

  createCollectionDownloadJob(input: {
    collectionJobId: string;
    requestedItemIds: string[];
    targetRoot: string;
    maxFilesPerItem: number;
  }): CollectionDownloadJobRecord {
    const job: CollectionDownloadJobRecord = {
      id: `download-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      collectionJobId: input.collectionJobId,
      requestedItemIds: [...input.requestedItemIds],
      targetRoot: input.targetRoot,
      maxFilesPerItem: input.maxFilesPerItem,
      status: 'queued',
      stage: 'waiting',
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      error: null,
      itemResults: [],
    };

    this.collectionDownloadJobs.set(job.id, job);
    return job;
  }

  getCollectionDownloadJob(downloadJobId: string): CollectionDownloadJobRecord | undefined {
    return this.collectionDownloadJobs.get(downloadJobId);
  }

  startCollectionDownloadJob(downloadJobId: string, stage = 'downloading'): void {
    const job = this.collectionDownloadJobs.get(downloadJobId);
    if (!job) {
      return;
    }
    job.status = 'running';
    job.stage = stage;
    job.startedAt = nowIso();
  }

  completeCollectionDownloadJob(
    downloadJobId: string,
    payload: {
      itemResults: CollectionDownloadItemResult[];
      stage?: string;
    },
  ): void {
    const job = this.collectionDownloadJobs.get(downloadJobId);
    if (!job) {
      return;
    }
    job.status = 'completed';
    job.stage = payload.stage ?? 'completed';
    job.itemResults = [...payload.itemResults];
    job.completedAt = nowIso();
  }

  failCollectionDownloadJob(downloadJobId: string, error: string): void {
    const job = this.collectionDownloadJobs.get(downloadJobId);
    if (!job) {
      return;
    }
    job.status = 'failed';
    job.stage = 'failed';
    job.error = error;
    job.completedAt = nowIso();
  }

  toCollectionDownloadJobStatus(downloadJobId: string): CollectionDownloadJobStatusResponse | undefined {
    const job = this.collectionDownloadJobs.get(downloadJobId);
    if (!job) {
      return undefined;
    }
    return {
      downloadJobId: job.id,
      collectionJobId: job.collectionJobId,
      status: job.status,
      stage: job.stage,
      itemCount: job.requestedItemIds.length,
      downloadedFileCount: job.itemResults.reduce((sum, item) => sum + item.files.length, 0),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  toCollectionDownloadJobResults(downloadJobId: string): CollectionDownloadJobResultsResponse | undefined {
    const job = this.collectionDownloadJobs.get(downloadJobId);
    if (!job) {
      return undefined;
    }
    return {
      downloadJobId: job.id,
      collectionJobId: job.collectionJobId,
      status: job.status,
      stage: job.stage,
      targetRoot: job.targetRoot,
      requestedItemIds: [...job.requestedItemIds],
      itemResults: [...job.itemResults],
    };
  }
}
