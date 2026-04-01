import { Injectable } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CreateDatasetInput,
  DatasetAnalysisResponse,
  DatasetRecord,
  DiscoveryJobRecord,
  DiscoveryJobResultsResponse,
  DiscoveryJobStatusResponse,
  DomainRecommendationResponse,
  SessionRecord,
} from '../common/contracts';
import { nowIso } from '../common/time';

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return normalized || 'dataset.csv';
}

@Injectable()
export class StoreService {
  private readonly rootDir = process.cwd();
  private readonly uploadDir = join(this.rootDir, 'storage', 'uploads');
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly datasets = new Map<string, DatasetRecord>();
  private readonly jobs = new Map<string, DiscoveryJobRecord>();

  constructor() {
    mkdirSync(this.uploadDir, { recursive: true });
  }

  createSession(): SessionRecord {
    const session: SessionRecord = {
      id: `session-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: nowIso(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  createDataset(input: CreateDatasetInput): DatasetRecord {
    const datasetId = `dataset-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const savedName = `${datasetId}-${sanitizeFileName(input.fileName)}`;
    const filePath = join(this.uploadDir, savedName);
    writeFileSync(filePath, input.rawBuffer);

    const dataset: DatasetRecord = {
      id: datasetId,
      sessionId: input.sessionId,
      fileName: input.fileName,
      filePath,
      rowCount: input.rows.length,
      colCount: input.columns.length,
      columns: [...input.columns],
      rows: input.rows,
      targetColumns: [...input.targetColumns],
      taskType: input.taskType,
      description: input.description,
      createdAt: nowIso(),
    };

    this.datasets.set(dataset.id, dataset);
    return dataset;
  }

  getDataset(datasetId: string): DatasetRecord | undefined {
    return this.datasets.get(datasetId);
  }

  setDatasetAnalysis(datasetId: string, analysis: DatasetAnalysisResponse): DatasetAnalysisResponse {
    const dataset = this.datasets.get(datasetId);
    if (dataset) {
      dataset.analysis = analysis;
    }
    return analysis;
  }

  setDatasetRecommendation(
    datasetId: string,
    recommendation: DomainRecommendationResponse,
  ): DomainRecommendationResponse {
    const dataset = this.datasets.get(datasetId);
    if (dataset) {
      dataset.recommendation = recommendation;
    }
    return recommendation;
  }

  createJob(input: {
    datasetId: string;
    sessionId: string;
    selectedDomains: string[];
    metadataColumns: string[];
  }): DiscoveryJobRecord {
    const job: DiscoveryJobRecord = {
      id: `job-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      datasetId: input.datasetId,
      sessionId: input.sessionId,
      selectedDomains: [...input.selectedDomains],
      metadataColumns: [...input.metadataColumns],
      status: 'queued',
      stage: 'waiting',
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      error: null,
      generatedQueries: [],
      expandedKeywords: [],
      knowledgeItems: [],
      datasetItems: [],
    };

    this.jobs.set(job.id, job);
    return job;
  }

  getJob(jobId: string): DiscoveryJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  startJob(jobId: string, payload: { stage: string; generatedQueries: string[]; expandedKeywords: string[] }): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'running';
    job.stage = payload.stage;
    job.startedAt = nowIso();
    job.generatedQueries = [...payload.generatedQueries];
    job.expandedKeywords = [...payload.expandedKeywords];
  }

  updateJobStage(jobId: string, stage: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.stage = stage;
    }
  }

  appendKnowledgeItem(jobId: string, item: DiscoveryJobRecord['knowledgeItems'][number]): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.knowledgeItems.push(item);
    }
  }

  appendDatasetItem(jobId: string, item: DiscoveryJobRecord['datasetItems'][number]): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.datasetItems.push(item);
    }
  }

  completeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'completed';
    job.stage = 'completed';
    job.completedAt = nowIso();
  }

  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'failed';
    job.stage = 'failed';
    job.error = error;
    job.completedAt = nowIso();
  }

  toJobStatus(jobId: string): DiscoveryJobStatusResponse | undefined {
    const job = this.jobs.get(jobId);
    if (!job) {
      return undefined;
    }
    return {
      jobId: job.id,
      datasetId: job.datasetId,
      status: job.status,
      stage: job.stage,
      knowledgeCount: job.knowledgeItems.length,
      datasetCount: job.datasetItems.length,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  toJobResults(jobId: string): DiscoveryJobResultsResponse | undefined {
    const job = this.jobs.get(jobId);
    if (!job) {
      return undefined;
    }
    return {
      jobId: job.id,
      datasetId: job.datasetId,
      status: job.status,
      stage: job.stage,
      generatedQueries: [...job.generatedQueries],
      expandedKeywords: [...job.expandedKeywords],
      knowledgeItems: [...job.knowledgeItems],
      datasetItems: [...job.datasetItems],
    };
  }
}
