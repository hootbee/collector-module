import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AuthProvider,
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
  OAuthAccountRecord,
  OrchestratorJobLogRecord,
  OrchestratorJobRecord,
  OrchestratorJobResultsResponse,
  OrchestratorJobStatusResponse,
  OrchestratorModuleType,
  PipelineRecord,
  RefreshTokenRecord,
  UserRecord,
} from '../common/contracts';
import { nowIso } from '../common/time';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class StoreService {
  private readonly collectionJobs = new Map<string, CollectionJobRecord>();
  private readonly collectionDownloadJobs = new Map<string, CollectionDownloadJobRecord>();
  private readonly orchestratorJobs = new Map<string, OrchestratorJobRecord>();
  private readonly orchestratorLogs = new Map<string, OrchestratorJobLogRecord[]>();
  private readonly pipelines = new Map<string, PipelineRecord>();
  private memoryLogId = 1;
  private readonly users = new Map<string, UserRecord>();
  private readonly oauthAccounts = new Map<string, OAuthAccountRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(private readonly databaseService: DatabaseService) {}

  async upsertOAuthUser(input: {
    provider: AuthProvider;
    providerUserId: string;
    email: string;
    name: string;
    avatarUrl?: string;
  }): Promise<UserRecord> {
    if (this.usePostgres()) {
      return this.upsertOAuthUserInPostgres(input);
    }
    return this.upsertOAuthUserInMemory(input);
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    if (this.usePostgres()) {
      const result = await this.databaseService.query<UserRow>(
        'select * from users where id = $1',
        [userId],
      );
      return result.rows[0] ? this.userFromRow(result.rows[0]) : undefined;
    }
    return this.users.get(userId);
  }

  async createRefreshToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: `refresh-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: nowIso(),
    };
    if (this.usePostgres()) {
      await this.databaseService.query(
        [
          'insert into refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at)',
          'values ($1, $2, $3, $4, $5, $6)',
        ].join(' '),
        [record.id, record.userId, record.tokenHash, record.expiresAt, record.revokedAt, record.createdAt],
      );
      return record;
    }
    this.refreshTokens.set(record.tokenHash, record);
    return record;
  }

  async getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    if (this.usePostgres()) {
      const result = await this.databaseService.query<RefreshTokenRow>(
        'select * from refresh_tokens where token_hash = $1',
        [tokenHash],
      );
      return result.rows[0] ? this.refreshTokenFromRow(result.rows[0]) : undefined;
    }
    return this.refreshTokens.get(tokenHash);
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    if (this.usePostgres()) {
      await this.databaseService.query(
        'update refresh_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = $1',
        [tokenHash],
      );
      return;
    }
    const record = this.refreshTokens.get(tokenHash);
    if (!record || record.revokedAt) {
      return;
    }
    this.refreshTokens.set(tokenHash, {
      ...record,
      revokedAt: nowIso(),
    });
  }

  async createOrchestratorJob(input: {
    userId?: string | null;
    pipelineId?: string | null;
    dataSourceId?: string | null;
    moduleType: OrchestratorModuleType;
    input: Record<string, unknown>;
  }): Promise<OrchestratorJobRecord> {
    const job: OrchestratorJobRecord = {
      id: `orch-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      userId: input.userId ?? null,
      pipelineId: input.pipelineId ?? null,
      dataSourceId: input.dataSourceId ?? null,
      moduleType: input.moduleType,
      status: 'queued',
      stage: 'waiting',
      input: { ...input.input },
      resultSummary: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    this.orchestratorJobs.set(job.id, job);
    await this.persistOrchestratorJob(job);
    await this.appendJobLog({
      jobId: job.id,
      jobType: 'orchestrator',
      level: 'info',
      message: 'orchestrator job queued',
      context: { moduleType: job.moduleType },
    });
    return job;
  }

  async getOrchestratorJob(jobId: string): Promise<OrchestratorJobRecord | undefined> {
    return this.loadOrchestratorJob(jobId);
  }

  async startOrchestratorJob(jobId: string, stage: string): Promise<void> {
    const job = await this.loadOrchestratorJob(jobId);
    if (!job) {
      return;
    }
    const next: OrchestratorJobRecord = {
      ...job,
      status: 'running',
      stage,
      startedAt: job.startedAt ?? nowIso(),
    };
    this.orchestratorJobs.set(next.id, next);
    await this.persistOrchestratorJob(next);
  }

  async completeOrchestratorJob(jobId: string, payload: {
    stage?: string;
    resultSummary: Record<string, unknown>;
  }): Promise<void> {
    const job = await this.loadOrchestratorJob(jobId);
    if (!job) {
      return;
    }
    const next: OrchestratorJobRecord = {
      ...job,
      status: 'completed',
      stage: payload.stage ?? 'completed',
      resultSummary: { ...payload.resultSummary },
      completedAt: nowIso(),
    };
    this.orchestratorJobs.set(next.id, next);
    await this.persistOrchestratorJob(next);
  }

  async failOrchestratorJob(jobId: string, error: string): Promise<void> {
    const job = await this.loadOrchestratorJob(jobId);
    if (!job) {
      return;
    }
    const next: OrchestratorJobRecord = {
      ...job,
      status: 'failed',
      stage: 'failed',
      error,
      completedAt: nowIso(),
    };
    this.orchestratorJobs.set(next.id, next);
    await this.persistOrchestratorJob(next);
  }

  async toOrchestratorJobStatus(jobId: string): Promise<OrchestratorJobStatusResponse | undefined> {
    const job = await this.loadOrchestratorJob(jobId);
    if (!job) {
      return undefined;
    }
    return this.toOrchestratorStatusResponse(job);
  }

  async toOrchestratorJobResults(jobId: string): Promise<OrchestratorJobResultsResponse | undefined> {
    const job = await this.loadOrchestratorJob(jobId);
    if (!job) {
      return undefined;
    }
    return {
      ...this.toOrchestratorStatusResponse(job),
      input: { ...job.input },
      resultSummary: job.resultSummary ? { ...job.resultSummary } : null,
    };
  }

  async appendJobLog(input: {
    jobId: string;
    jobType: string;
    level: OrchestratorJobLogRecord['level'];
    message: string;
    context?: Record<string, unknown>;
  }): Promise<OrchestratorJobLogRecord> {
    if (this.usePostgres()) {
      const result = await this.databaseService.query<JobLogRow>(
        [
          'insert into job_logs (job_id, job_type, level, message, context)',
          'values ($1, $2, $3, $4, $5)',
          'returning *',
        ].join(' '),
        [input.jobId, input.jobType, input.level, input.message, JSON.stringify(input.context ?? {})],
      );
      return this.jobLogFromRow(result.rows[0]);
    }

    const record: OrchestratorJobLogRecord = {
      id: this.memoryLogId,
      jobId: input.jobId,
      jobType: input.jobType,
      level: input.level,
      message: input.message,
      context: { ...(input.context ?? {}) },
      createdAt: nowIso(),
    };
    this.memoryLogId += 1;
    this.orchestratorLogs.set(input.jobId, [...(this.orchestratorLogs.get(input.jobId) ?? []), record]);
    return record;
  }

  async getJobLogs(jobId: string): Promise<OrchestratorJobLogRecord[]> {
    if (this.usePostgres()) {
      const result = await this.databaseService.query<JobLogRow>(
        'select * from job_logs where job_id = $1 order by created_at asc, id asc',
        [jobId],
      );
      return result.rows.map((row) => this.jobLogFromRow(row));
    }
    return [...(this.orchestratorLogs.get(jobId) ?? [])];
  }

  async createPipeline(input: {
    userId?: string | null;
    kind: string;
    domainKey?: string | null;
    domainLabel?: string | null;
    title: string;
    description?: string;
    moduleIds?: string[];
    connectedAfter?: string[];
    moduleLayout?: Record<string, unknown>;
    highlight?: string | null;
    autoNamed?: boolean;
  }): Promise<PipelineRecord> {
    const now = nowIso();
    const pipeline: PipelineRecord = {
      id: `pipe-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      userId: input.userId ?? null,
      kind: input.kind,
      domainKey: input.domainKey ?? null,
      domainLabel: input.domainLabel ?? null,
      title: input.title,
      description: input.description ?? '',
      moduleIds: [...(input.moduleIds ?? [])],
      connectedAfter: [...(input.connectedAfter ?? [])],
      moduleLayout: { ...(input.moduleLayout ?? {}) },
      highlight: input.highlight ?? null,
      autoNamed: input.autoNamed ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.pipelines.set(pipeline.id, pipeline);
    await this.persistPipeline(pipeline);
    return pipeline;
  }

  async listPipelines(userId?: string | null): Promise<PipelineRecord[]> {
    if (this.usePostgres()) {
      const result = userId
        ? await this.databaseService.query<PipelineRow>(
            'select * from pipelines where user_id = $1 order by updated_at desc',
            [userId],
          )
        : await this.databaseService.query<PipelineRow>(
            'select * from pipelines order by updated_at desc limit 100',
          );
      return result.rows.map((row) => this.pipelineFromRow(row));
    }
    return [...this.pipelines.values()]
      .filter((pipeline) => !userId || pipeline.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPipeline(pipelineId: string): Promise<PipelineRecord | undefined> {
    const cached = this.pipelines.get(pipelineId);
    if (cached) {
      return cached;
    }
    if (!this.usePostgres()) {
      return undefined;
    }
    const result = await this.databaseService.query<PipelineRow>(
      'select * from pipelines where id = $1',
      [pipelineId],
    );
    const pipeline = result.rows[0] ? this.pipelineFromRow(result.rows[0]) : undefined;
    if (pipeline) {
      this.pipelines.set(pipeline.id, pipeline);
    }
    return pipeline;
  }

  async updatePipelineModules(pipelineId: string, payload: {
    moduleIds: string[];
    connectedAfter: string[];
    moduleLayout: Record<string, unknown>;
  }): Promise<PipelineRecord | undefined> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline) {
      return undefined;
    }
    const next: PipelineRecord = {
      ...pipeline,
      moduleIds: [...payload.moduleIds],
      connectedAfter: [...payload.connectedAfter],
      moduleLayout: { ...payload.moduleLayout },
      updatedAt: nowIso(),
    };
    this.pipelines.set(next.id, next);
    await this.persistPipeline(next);
    return next;
  }

  async createCollectionJob(input: {
    query: string;
    kind: CollectionKind;
    requestedSources: CollectionSourceId[];
    taskSignals: CollectionJobRecord['taskSignals'];
    modalitySignals: CollectionJobRecord['modalitySignals'];
  }): Promise<CollectionJobRecord> {
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
    await this.persistCollectionJob(job);
    return job;
  }

  async getCollectionJob(jobId: string): Promise<CollectionJobRecord | undefined> {
    return this.loadCollectionJob(jobId);
  }

  async startCollectionJob(jobId: string, payload: {
    stage: string;
    datasetQueries: string[];
    knowledgeQueries: string[];
    mustInclude: string[];
    mustAvoid: string[];
    llmPlanRaw?: string | null;
    llmPlan?: CollectionLlmPlan | null;
  }): Promise<void> {
    const job = await this.loadCollectionJob(jobId);
    if (!job) {
      return;
    }
    const next: CollectionJobRecord = {
      ...job,
      status: 'running',
      stage: payload.stage,
      startedAt: nowIso(),
      datasetQueries: [...payload.datasetQueries],
      knowledgeQueries: [...payload.knowledgeQueries],
      mustInclude: [...payload.mustInclude],
      mustAvoid: [...payload.mustAvoid],
      llmPlanRaw: payload.llmPlanRaw ?? null,
      llmPlan: payload.llmPlan ?? null,
    };
    this.collectionJobs.set(next.id, next);
    await this.persistCollectionJob(next);
  }

  async completeCollectionJob(jobId: string, payload: {
    stage?: string;
    connectorStatuses: CollectionConnectorStatus[];
    routedHits: CollectionJobRecord['routedHits'];
    fetchedDocuments: CollectionJobRecord['fetchedDocuments'];
    rawKnowledgeHits: CollectionJobRecord['rawKnowledgeHits'];
    rawDatasetHits: CollectionJobRecord['rawDatasetHits'];
    knowledgeItems: CollectionJobRecord['knowledgeItems'];
    datasetItems: CollectionJobRecord['datasetItems'];
  }): Promise<void> {
    const job = await this.loadCollectionJob(jobId);
    if (!job) {
      return;
    }
    const next: CollectionJobRecord = {
      ...job,
      status: 'completed',
      stage: payload.stage ?? 'completed',
      connectorStatuses: [...payload.connectorStatuses],
      routedHits: [...payload.routedHits],
      fetchedDocuments: [...payload.fetchedDocuments],
      rawKnowledgeHits: [...payload.rawKnowledgeHits],
      rawDatasetHits: [...payload.rawDatasetHits],
      knowledgeItems: [...payload.knowledgeItems],
      datasetItems: [...payload.datasetItems],
      completedAt: nowIso(),
    };
    this.collectionJobs.set(next.id, next);
    await this.persistCollectionJob(next);
  }

  async failCollectionJob(jobId: string, error: string): Promise<void> {
    const job = await this.loadCollectionJob(jobId);
    if (!job) {
      return;
    }
    const next: CollectionJobRecord = {
      ...job,
      status: 'failed',
      stage: 'failed',
      error,
      completedAt: nowIso(),
    };
    this.collectionJobs.set(next.id, next);
    await this.persistCollectionJob(next);
  }

  async toCollectionJobStatus(jobId: string): Promise<CollectionJobStatusResponse | undefined> {
    const job = await this.loadCollectionJob(jobId);
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

  async toCollectionJobResults(jobId: string): Promise<CollectionJobResultsResponse | undefined> {
    const job = await this.loadCollectionJob(jobId);
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

  async createCollectionDownloadJob(input: {
    collectionJobId: string;
    requestedItemIds: string[];
    targetRoot: string;
    maxFilesPerItem: number;
  }): Promise<CollectionDownloadJobRecord> {
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
    await this.persistDownloadJob(job);
    return job;
  }

  async getCollectionDownloadJob(downloadJobId: string): Promise<CollectionDownloadJobRecord | undefined> {
    return this.loadDownloadJob(downloadJobId);
  }

  async startCollectionDownloadJob(downloadJobId: string, stage = 'downloading'): Promise<void> {
    const job = await this.loadDownloadJob(downloadJobId);
    if (!job) {
      return;
    }
    const next: CollectionDownloadJobRecord = {
      ...job,
      status: 'running',
      stage,
      startedAt: nowIso(),
    };
    this.collectionDownloadJobs.set(next.id, next);
    await this.persistDownloadJob(next);
  }

  async completeCollectionDownloadJob(
    downloadJobId: string,
    payload: {
      itemResults: CollectionDownloadItemResult[];
      stage?: string;
    },
  ): Promise<void> {
    const job = await this.loadDownloadJob(downloadJobId);
    if (!job) {
      return;
    }
    const next: CollectionDownloadJobRecord = {
      ...job,
      status: 'completed',
      stage: payload.stage ?? 'completed',
      itemResults: [...payload.itemResults],
      completedAt: nowIso(),
    };
    this.collectionDownloadJobs.set(next.id, next);
    await this.persistDownloadJob(next);
  }

  async failCollectionDownloadJob(downloadJobId: string, error: string): Promise<void> {
    const job = await this.loadDownloadJob(downloadJobId);
    if (!job) {
      return;
    }
    const next: CollectionDownloadJobRecord = {
      ...job,
      status: 'failed',
      stage: 'failed',
      error,
      completedAt: nowIso(),
    };
    this.collectionDownloadJobs.set(next.id, next);
    await this.persistDownloadJob(next);
  }

  async toCollectionDownloadJobStatus(downloadJobId: string): Promise<CollectionDownloadJobStatusResponse | undefined> {
    const job = await this.loadDownloadJob(downloadJobId);
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

  async toCollectionDownloadJobResults(downloadJobId: string): Promise<CollectionDownloadJobResultsResponse | undefined> {
    const job = await this.loadDownloadJob(downloadJobId);
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

  private async upsertOAuthUserInPostgres(input: {
    provider: AuthProvider;
    providerUserId: string;
    email: string;
    name: string;
    avatarUrl?: string;
  }): Promise<UserRecord> {
    return this.databaseService.withClient(async (client) => {
      await client.query('begin');
      try {
        const account = await client.query<OAuthAccountRow>(
          'select * from oauth_accounts where provider = $1 and provider_user_id = $2',
          [input.provider, input.providerUserId],
        );
        const now = nowIso();
        let userId = account.rows[0]?.user_id;
        if (!userId) {
          const existing = await client.query<UserRow>('select * from users where lower(email) = lower($1)', [input.email]);
          userId = existing.rows[0]?.id ?? `user-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        }

        const userResult = await client.query<UserRow>(
          [
            'insert into users (id, email, name, avatar_url, role, created_at, updated_at)',
            'values ($1, $2, $3, $4, $5, $6, $7)',
            'on conflict (id) do update set',
            'email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at',
            'returning *',
          ].join(' '),
          [userId, input.email, input.name || input.email, input.avatarUrl ?? null, 'user', now, now],
        );

        await client.query(
          [
            'insert into oauth_accounts (id, user_id, provider, provider_user_id, email, created_at, updated_at)',
            'values ($1, $2, $3, $4, $5, $6, $7)',
            'on conflict (provider, provider_user_id) do update set',
            'user_id = excluded.user_id, email = excluded.email, updated_at = excluded.updated_at',
          ].join(' '),
          [
            account.rows[0]?.id ?? `oauth-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
            userId,
            input.provider,
            input.providerUserId,
            input.email,
            now,
            now,
          ],
        );

        await client.query('commit');
        return this.userFromRow(userResult.rows[0]);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  private upsertOAuthUserInMemory(input: {
    provider: AuthProvider;
    providerUserId: string;
    email: string;
    name: string;
    avatarUrl?: string;
  }): UserRecord {
    const now = nowIso();
    const accountKey = this.oauthAccountKey(input.provider, input.providerUserId);
    const existingAccount = this.oauthAccounts.get(accountKey);
    if (existingAccount) {
      const user = this.users.get(existingAccount.userId);
      if (user) {
        const updated: UserRecord = {
          ...user,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          updatedAt: now,
        };
        this.users.set(updated.id, updated);
        this.oauthAccounts.set(accountKey, {
          ...existingAccount,
          email: input.email,
          updatedAt: now,
        });
        return updated;
      }
    }

    const existingUser = this.findUserByEmail(input.email);
    const user: UserRecord = existingUser
      ? {
          ...existingUser,
          name: input.name || existingUser.name,
          avatarUrl: input.avatarUrl || existingUser.avatarUrl,
          updatedAt: now,
        }
      : {
          id: `user-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          email: input.email,
          name: input.name || input.email,
          avatarUrl: input.avatarUrl,
          role: 'user',
          createdAt: now,
          updatedAt: now,
        };

    this.users.set(user.id, user);
    this.oauthAccounts.set(accountKey, {
      id: `oauth-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      userId: user.id,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email,
      createdAt: now,
      updatedAt: now,
    });
    return user;
  }

  private async persistOrchestratorJob(job: OrchestratorJobRecord): Promise<void> {
    if (!this.usePostgres()) {
      return;
    }
    await this.databaseService.query(
      [
        'insert into orchestrator_jobs (id, user_id, pipeline_id, data_source_id, module_type, status, stage, input, result_summary, error, created_at, started_at, completed_at)',
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        'on conflict (id) do update set',
        'user_id = excluded.user_id, pipeline_id = excluded.pipeline_id, data_source_id = excluded.data_source_id,',
        'module_type = excluded.module_type, status = excluded.status, stage = excluded.stage, input = excluded.input,',
        'result_summary = excluded.result_summary, error = excluded.error, started_at = excluded.started_at, completed_at = excluded.completed_at',
      ].join(' '),
      [
        job.id,
        job.userId,
        job.pipelineId,
        job.dataSourceId,
        job.moduleType,
        job.status,
        job.stage,
        JSON.stringify(job.input),
        JSON.stringify(job.resultSummary),
        job.error,
        job.createdAt,
        job.startedAt,
        job.completedAt,
      ],
    );
  }

  private async persistPipeline(pipeline: PipelineRecord): Promise<void> {
    if (!this.usePostgres()) {
      return;
    }
    await this.databaseService.query(
      [
        'insert into pipelines (id, user_id, kind, domain_key, domain_label, title, description, module_ids, connected_after, module_layout, highlight, auto_named, created_at, updated_at)',
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        'on conflict (id) do update set',
        'user_id = excluded.user_id, kind = excluded.kind, domain_key = excluded.domain_key, domain_label = excluded.domain_label,',
        'title = excluded.title, description = excluded.description, module_ids = excluded.module_ids,',
        'connected_after = excluded.connected_after, module_layout = excluded.module_layout,',
        'highlight = excluded.highlight, auto_named = excluded.auto_named, updated_at = excluded.updated_at',
      ].join(' '),
      [
        pipeline.id,
        pipeline.userId,
        pipeline.kind,
        pipeline.domainKey,
        pipeline.domainLabel,
        pipeline.title,
        pipeline.description,
        JSON.stringify(pipeline.moduleIds),
        JSON.stringify(pipeline.connectedAfter),
        JSON.stringify(pipeline.moduleLayout),
        pipeline.highlight,
        pipeline.autoNamed,
        pipeline.createdAt,
        pipeline.updatedAt,
      ],
    );
  }

  private async persistCollectionJob(job: CollectionJobRecord): Promise<void> {
    if (!this.usePostgres()) {
      return;
    }
    await this.databaseService.query(
      [
        'insert into collection_jobs (id, query, kind, sources, status, stage, dataset_queries, knowledge_queries, connector_statuses, llm_plan, record, error, created_at, started_at, completed_at)',
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
        'on conflict (id) do update set',
        'query = excluded.query, kind = excluded.kind, sources = excluded.sources, status = excluded.status, stage = excluded.stage,',
        'dataset_queries = excluded.dataset_queries, knowledge_queries = excluded.knowledge_queries,',
        'connector_statuses = excluded.connector_statuses, llm_plan = excluded.llm_plan, record = excluded.record,',
        'error = excluded.error, started_at = excluded.started_at, completed_at = excluded.completed_at',
      ].join(' '),
      [
        job.id,
        job.query,
        job.kind,
        JSON.stringify(job.requestedSources),
        job.status,
        job.stage,
        JSON.stringify(job.datasetQueries),
        JSON.stringify(job.knowledgeQueries),
        JSON.stringify(job.connectorStatuses),
        JSON.stringify(job.llmPlan),
        JSON.stringify(job),
        job.error,
        job.createdAt,
        job.startedAt,
        job.completedAt,
      ],
    );
  }

  private async persistDownloadJob(job: CollectionDownloadJobRecord): Promise<void> {
    if (!this.usePostgres()) {
      return;
    }
    await this.databaseService.query(
      [
        'insert into download_jobs (id, collection_job_id, status, stage, target_root, requested_item_ids, max_files_per_item, item_results, record, error, created_at, started_at, completed_at)',
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        'on conflict (id) do update set',
        'collection_job_id = excluded.collection_job_id, status = excluded.status, stage = excluded.stage,',
        'target_root = excluded.target_root, requested_item_ids = excluded.requested_item_ids,',
        'max_files_per_item = excluded.max_files_per_item, item_results = excluded.item_results,',
        'record = excluded.record, error = excluded.error, started_at = excluded.started_at, completed_at = excluded.completed_at',
      ].join(' '),
      [
        job.id,
        job.collectionJobId,
        job.status,
        job.stage,
        job.targetRoot,
        JSON.stringify(job.requestedItemIds),
        job.maxFilesPerItem,
        JSON.stringify(job.itemResults),
        JSON.stringify(job),
        job.error,
        job.createdAt,
        job.startedAt,
        job.completedAt,
      ],
    );
  }

  private async loadOrchestratorJob(jobId: string): Promise<OrchestratorJobRecord | undefined> {
    const cached = this.orchestratorJobs.get(jobId);
    if (cached) {
      return cached;
    }
    if (!this.usePostgres()) {
      return undefined;
    }
    const result = await this.databaseService.query<OrchestratorJobRow>(
      'select * from orchestrator_jobs where id = $1',
      [jobId],
    );
    const record = result.rows[0] ? this.orchestratorJobFromRow(result.rows[0]) : undefined;
    if (record) {
      this.orchestratorJobs.set(record.id, record);
    }
    return record;
  }

  private async loadCollectionJob(jobId: string): Promise<CollectionJobRecord | undefined> {
    const cached = this.collectionJobs.get(jobId);
    if (cached) {
      return cached;
    }
    if (!this.usePostgres()) {
      return undefined;
    }
    const result = await this.databaseService.query<{ record: CollectionJobRecord }>(
      'select record from collection_jobs where id = $1',
      [jobId],
    );
    const record = result.rows[0]?.record;
    if (record) {
      this.collectionJobs.set(record.id, record);
    }
    return record;
  }

  private async loadDownloadJob(downloadJobId: string): Promise<CollectionDownloadJobRecord | undefined> {
    const cached = this.collectionDownloadJobs.get(downloadJobId);
    if (cached) {
      return cached;
    }
    if (!this.usePostgres()) {
      return undefined;
    }
    const result = await this.databaseService.query<{ record: CollectionDownloadJobRecord }>(
      'select record from download_jobs where id = $1',
      [downloadJobId],
    );
    const record = result.rows[0]?.record;
    if (record) {
      this.collectionDownloadJobs.set(record.id, record);
    }
    return record;
  }

  private usePostgres(): boolean {
    return process.env.STORE_BACKEND?.trim() !== 'memory' && this.databaseService.isConfigured();
  }

  private findUserByEmail(email: string): UserRecord | undefined {
    const normalized = email.trim().toLowerCase();
    return [...this.users.values()].find((user) => user.email.toLowerCase() === normalized);
  }

  private oauthAccountKey(provider: AuthProvider, providerUserId: string): string {
    return `${provider}:${providerUserId}`;
  }

  private userFromRow(row: UserRow): UserRecord {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url ?? undefined,
      role: row.role,
      createdAt: this.iso(row.created_at),
      updatedAt: this.iso(row.updated_at),
    };
  }

  private refreshTokenFromRow(row: RefreshTokenRow): RefreshTokenRecord {
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: this.iso(row.expires_at),
      revokedAt: row.revoked_at ? this.iso(row.revoked_at) : null,
      createdAt: this.iso(row.created_at),
    };
  }

  private orchestratorJobFromRow(row: OrchestratorJobRow): OrchestratorJobRecord {
    return {
      id: row.id,
      userId: row.user_id,
      pipelineId: row.pipeline_id,
      dataSourceId: row.data_source_id,
      moduleType: row.module_type,
      status: row.status,
      stage: row.stage,
      input: this.objectFromJson(row.input),
      resultSummary: row.result_summary ? this.objectFromJson(row.result_summary) : null,
      error: row.error,
      createdAt: this.iso(row.created_at),
      startedAt: row.started_at ? this.iso(row.started_at) : null,
      completedAt: row.completed_at ? this.iso(row.completed_at) : null,
    };
  }

  private toOrchestratorStatusResponse(job: OrchestratorJobRecord): OrchestratorJobStatusResponse {
    return {
      jobId: job.id,
      userId: job.userId,
      pipelineId: job.pipelineId,
      dataSourceId: job.dataSourceId,
      moduleType: job.moduleType,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  private jobLogFromRow(row: JobLogRow): OrchestratorJobLogRecord {
    return {
      id: Number(row.id),
      jobId: row.job_id,
      jobType: row.job_type,
      level: row.level,
      message: row.message,
      context: this.objectFromJson(row.context),
      createdAt: this.iso(row.created_at),
    };
  }

  private pipelineFromRow(row: PipelineRow): PipelineRecord {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      domainKey: row.domain_key,
      domainLabel: row.domain_label,
      title: row.title,
      description: row.description,
      moduleIds: this.stringListFromJson(row.module_ids),
      connectedAfter: this.stringListFromJson(row.connected_after),
      moduleLayout: this.objectFromJson(row.module_layout),
      highlight: row.highlight,
      autoNamed: row.auto_named,
      createdAt: this.iso(row.created_at),
      updatedAt: this.iso(row.updated_at),
    };
  }

  private objectFromJson(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private stringListFromJson(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private iso(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: string | Date;
  updated_at: string | Date;
};

type OAuthAccountRow = {
  id: string;
  user_id: string;
  provider: AuthProvider;
  provider_user_id: string;
  email: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type RefreshTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  created_at: string | Date;
};

type OrchestratorJobRow = {
  id: string;
  user_id: string | null;
  pipeline_id: string | null;
  data_source_id: string | null;
  module_type: OrchestratorModuleType;
  status: OrchestratorJobRecord['status'];
  stage: string;
  input: unknown;
  result_summary: unknown | null;
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
};

type JobLogRow = {
  id: number | string;
  job_id: string;
  job_type: string;
  level: OrchestratorJobLogRecord['level'];
  message: string;
  context: unknown;
  created_at: string | Date;
};

type PipelineRow = {
  id: string;
  user_id: string | null;
  kind: string;
  domain_key: string | null;
  domain_label: string | null;
  title: string;
  description: string;
  module_ids: unknown;
  connected_after: unknown;
  module_layout: unknown;
  highlight: string | null;
  auto_named: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};
