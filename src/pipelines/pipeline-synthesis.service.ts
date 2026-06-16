import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { StoreService } from '../store/store.service';
import { PipelineDataMergeService } from './pipeline-data-merge.service';

export type SynthesisArtifactMeta = {
  artifactId: string;
  pipelineId: string;
  userId: string;
  fileName: string;
  filePath: string;
  originalRowCount: number;
  syntheticRowCount: number;
  totalRowCount: number;
  targetColumn: string;
  minorityLabel: string;
  mode: string;
  createdAt: string;
};

export type SynthesisPlanSnapshot = {
  dataSourceId: string;
  targetColumn: string;
  minorityLabel: string;
  minorityCount: number;
  columnNames: string[];
  targetSyntheticCount: number;
  userSpecifiedRowCount: number | null;
  constraintsText: string;
  synthesisOptions: SynthesisOptions;
  strategySummary: string;
  recommendationRationale: string;
  distributionBefore: string;
  subTaskResults: SynthesisSubTaskResult[];
  sourceFileName: string;
  originalRowCount: number;
  mergeArtifactId?: string | null;
  sourceKind?: 'original' | 'merged';
};

export type SynthesisProgress = {
  generatedCount: number;
  targetCount: number;
  currentBatch: number;
  totalBatches: number;
  batchSize: number;
  complete: boolean;
};

export type SynthesisGenerationResult = {
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  artifact?: SynthesisArtifactMeta | null;
  subTaskResults: SynthesisSubTaskResult[];
  synthesisVisuals: PipelineStepSynthesisVisuals;
  synthesisPlan?: SynthesisPlanSnapshot | null;
  synthesisProgress?: SynthesisProgress | null;
};

export type SynthesisSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type PipelineStepSynthesisVisuals = {
  mode: string;
  targetColumn: string;
  minorityLabel: string;
  originalMinorityCount: number;
  userSpecifiedRowCount: number | null;
  recommendedRowCount: number;
  actualSyntheticCount: number;
  distributionBefore: string;
  distributionAfter: string;
  constraintsApplied: string[];
  strategySummary: string;
  recommendationRationale: string;
};

type SynthesisOptions = {
  mode?: string;
  targetSyntheticCount?: number | null;
  constraints?: {
    preserveLabelSemantics?: boolean;
    preserveFeatureRanges?: boolean;
    excludeUnrealisticSamples?: boolean;
  };
};

const SYNTHESIS_ADDON_CATALOG: Record<string, { label: string; description: string }> = {
  addon_syn_strategy_recommend: {
    label: '보완 전략 추천',
    description: '데이터 특성에 따라 합성·가중치·외부 병합 전략을 추천합니다.',
  },
  addon_syn_anomaly_generation_conditions: {
    label: '이상 샘플 생성 조건 설정',
    description: '이상 클래스별 생성 조건, 생성 비율, 제외 조건을 설정합니다.',
  },
  addon_syn_domain_constraint_rules: {
    label: '도메인 제약 기반 생성 규칙',
    description: '의료 변수 범위, 변수 관계, 라벨 조건을 반영한 생성 규칙을 정의합니다.',
  },
  addon_syn_timeseries_anomaly_patterns: {
    label: '시계열 이상 패턴 설계',
    description: '급격한 악화, 점진적 악화, 회복 후 재악화 패턴을 설계합니다.',
  },
  addon_syn_method_comparison: {
    label: '생성 방식 비교 선택',
    description: 'SMOTE, 통계 기반, 생성 모델 기반 방식을 비교합니다.',
  },
};

const DEFAULT_SYNTHESIS_ADDON_IDS = [
  'addon_syn_strategy_recommend',
  'addon_syn_anomaly_generation_conditions',
  'addon_syn_domain_constraint_rules',
  'addon_syn_timeseries_anomaly_patterns',
];

const SYNTHESIS_BATCH_SIZE = 25;

function seededUnitRandom(seed: string, index: number): number {
  let hash = 2166136261;
  const text = `${seed}:${index}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function shuffleWithSeed<T>(items: T[], seed: string): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(seededUnitRandom(seed, i) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function countSynthesisBatches(targetCount: number, batchSize = SYNTHESIS_BATCH_SIZE): number {
  if (targetCount <= 0) return 0;
  return Math.ceil(targetCount / batchSize);
}

function countCompletedBatches(generatedCount: number, batchSize = SYNTHESIS_BATCH_SIZE): number {
  if (generatedCount <= 0) return 0;
  return Math.ceil(generatedCount / batchSize);
}

@Injectable()
export class PipelineSynthesisService {
  private readonly artifactDir = (
    process.env.SYNTHESIS_ARTIFACT_DIR?.trim() || join(process.cwd(), 'storage', 'synthesis-artifacts')
  );
  private readonly artifacts = new Map<string, SynthesisArtifactMeta>();

  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
    private readonly mergeService: PipelineDataMergeService,
  ) {}

  async getArtifact(
    pipelineId: string,
    artifactId: string,
    actorUserId: string,
  ): Promise<SynthesisArtifactMeta> {
    const artifact = this.artifacts.get(artifactId);
    if (artifact && artifact.pipelineId === pipelineId && artifact.userId === actorUserId) {
      return artifact;
    }
    const hydrated = await this.hydrateArtifactFromDisk(artifactId, pipelineId, actorUserId);
    if (hydrated) {
      this.artifacts.set(artifactId, hydrated);
      return hydrated;
    }
    throw new NotFoundException('합성 결과 파일을 찾을 수 없습니다.');
  }

  async resolveArtifactForPipeline(
    pipelineId: string,
    actorUserId: string,
    artifactId?: string | null,
  ): Promise<SynthesisArtifactMeta | null> {
    if (artifactId?.trim()) {
      try {
        return await this.getArtifact(pipelineId, artifactId.trim(), actorUserId);
      } catch {
        const hydrated = await this.hydrateArtifactFromDisk(artifactId.trim(), pipelineId, actorUserId);
        if (hydrated) {
          this.artifacts.set(hydrated.artifactId, hydrated);
          return hydrated;
        }
      }
    }
    return this.findLatestArtifactForPipeline(pipelineId, actorUserId);
  }

  async findLatestArtifactForPipeline(
    pipelineId: string,
    actorUserId: string,
  ): Promise<SynthesisArtifactMeta | null> {
    const fromMemory = [...this.artifacts.values()]
      .filter((item) => item.pipelineId === pipelineId && item.userId === actorUserId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (fromMemory[0]) return fromMemory[0];

    await mkdir(this.artifactDir, { recursive: true });
    const entries = await readdir(this.artifactDir);
    const metas: SynthesisArtifactMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const raw = await readFile(join(this.artifactDir, entry), 'utf8');
        const parsed = JSON.parse(raw) as SynthesisArtifactMeta;
        if (parsed.pipelineId === pipelineId && parsed.userId === actorUserId && parsed.artifactId) {
          metas.push(parsed);
        }
      } catch {
        // skip invalid meta
      }
    }
    metas.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (metas[0]) {
      this.artifacts.set(metas[0].artifactId, metas[0]);
      return metas[0];
    }
    return null;
  }

  private async persistArtifactMeta(artifact: SynthesisArtifactMeta): Promise<void> {
    const metaPath = join(this.artifactDir, `${artifact.artifactId}.meta.json`);
    await writeFile(metaPath, JSON.stringify(artifact), 'utf8');
  }

  private async hydrateArtifactFromDisk(
    artifactId: string,
    pipelineId: string,
    actorUserId: string,
  ): Promise<SynthesisArtifactMeta | null> {
    const metaPath = join(this.artifactDir, `${artifactId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(await readFile(metaPath, 'utf8')) as SynthesisArtifactMeta;
        if (parsed.pipelineId === pipelineId && parsed.userId === actorUserId) {
          return parsed;
        }
      } catch {
        // fall through to csv parse
      }
    }

    const filePath = join(this.artifactDir, `${artifactId}.csv`);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
    });
    const rows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    if (!rows.length) return null;

    const hasFlag = rows.some((row) => row.is_synthetic !== undefined);
    const syntheticRowCount = hasFlag
      ? rows.filter((row) => String(row.is_synthetic ?? '0') === '1').length
      : 0;
    const originalRowCount = hasFlag ? rows.length - syntheticRowCount : rows.length;
    const baseName = artifactId;
    const artifact: SynthesisArtifactMeta = {
      artifactId,
      pipelineId,
      userId: actorUserId,
      fileName: `${baseName}_synthetic_augmented.csv`,
      filePath,
      originalRowCount,
      syntheticRowCount,
      totalRowCount: rows.length,
      targetColumn: '',
      minorityLabel: '',
      mode: 'domain_guided',
      createdAt: new Date().toISOString(),
    };
    if (syntheticRowCount <= 0) return null;
    await this.persistArtifactMeta(artifact);
    return artifact;
  }

  async readArtifactContent(artifact: SynthesisArtifactMeta): Promise<Buffer> {
    return readFile(artifact.filePath);
  }

  async generateSyntheticDataset(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      analysis?: DataSourceAnalysisResult | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<SynthesisGenerationResult> {
    const execution = this.readSynthesisExecution(input.context);
    if (execution.phase === 'plan') {
      return this.executeSynthesisPlanPhase(actorUserId, pipelineId, input);
    }
    if (execution.phase === 'batch') {
      return this.executeSynthesisBatchPhase(actorUserId, pipelineId, input, execution);
    }

    const dataSourceId = input.dataSourceId?.trim();
    if (!dataSourceId) {
      throw new BadRequestException('합성을 위해 연결된 데이터 소스가 필요합니다.');
    }

    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('합성할 원본 CSV 파일이 없습니다.');
    }

    const parsed = Papa.parse<Record<string, string>>(sample.content.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    const originalRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    if (!originalRows.length) {
      throw new BadRequestException('원본 CSV에 데이터 행이 없습니다.');
    }

    const columnNames = parsed.meta.fields?.filter(Boolean) ?? Object.keys(originalRows[0] ?? {});
    const analysis = input.analysis ?? null;
    const ctx = input.context ?? null;
    const synthesisOptions = this.readSynthesisOptions(ctx);
    const selectedAddonIds = this.resolveSelectedAddonIds(ctx);
    const { targetColumn, minorityLabel } = this.resolveSynthesisTargets(
      columnNames,
      analysis,
      ctx,
      originalRows,
    );
    const distribution = this.countDistribution(originalRows, targetColumn);
    const minorityCount = distribution[minorityLabel] ?? 0;
    const distributionBefore = this.describeDistribution(distribution, minorityLabel, originalRows.length);

    const recommendation = await this.resolveSyntheticRowCount({
      synthesisOptions,
      minorityCount,
      distribution,
      minorityLabel,
      analysis,
      context: ctx,
    });

    const constraintsText = this.buildConstraintsText(synthesisOptions);
    const codeSubTasks = this.runCodeBasedSubTasks(
      selectedAddonIds,
      synthesisOptions,
      minorityLabel,
      minorityCount,
      recommendation.count,
      constraintsText,
      ctx,
    );

    let subTaskResults = codeSubTasks;
    let strategySummary = recommendation.rationale;
    let llmPlanUsed = false;

    if (this.llmClient.isConfigured()) {
      try {
        const llmPlan = await this.requestLlmSynthesisPlan({
          selectedAddonIds,
          synthesisOptions,
          columnNames,
          targetColumn,
          minorityLabel,
          minorityCount,
          distribution,
          recommendedCount: recommendation.count,
          userSpecifiedCount: synthesisOptions.targetSyntheticCount ?? null,
          analysis,
          constraintsText,
          minorityExamples: originalRows
            .filter((row) => String(row[targetColumn] ?? '').trim() === minorityLabel)
            .slice(0, 8),
          context: input.context ?? null,
        });
        subTaskResults = this.mergeSubTaskResults(codeSubTasks, llmPlan.subTaskResults);
        if (llmPlan.strategySummary) strategySummary = llmPlan.strategySummary;
        if (!synthesisOptions.targetSyntheticCount && llmPlan.recommendedRowCount > 0) {
          recommendation.count = llmPlan.recommendedRowCount;
          recommendation.rationale = llmPlan.recommendationRationale || recommendation.rationale;
        }
        llmPlanUsed = true;
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    const targetSyntheticCount = synthesisOptions.targetSyntheticCount
      ? Math.min(synthesisOptions.targetSyntheticCount, 2000)
      : recommendation.count;

    const minorityExamples = originalRows
      .filter((row) => String(row[targetColumn] ?? '').trim() === minorityLabel)
      .slice(0, 25);

    const rowLlmUsed = this.llmClient.isConfigured();
    const fullDiversitySeed = `${pipelineId}:full:${randomUUID()}`;
    const syntheticRows = await this.generateRows({
      columnNames,
      targetColumn,
      minorityLabel,
      minorityExamples: this.pickDiverseMinorityExamples(minorityExamples, minorityExamples.length, fullDiversitySeed),
      targetCount: targetSyntheticCount,
      analysis,
      synthesisOptions,
      constraintsText: this.buildConstraintsText(synthesisOptions),
      context: ctx,
      batchIndex: 1,
      totalBatches: 1,
      generatedSoFar: 0,
      priorSyntheticRows: [],
      diversitySeed: fullDiversitySeed,
    });

    const augmentedRows = [
      ...originalRows.map((row) => ({ ...row, is_synthetic: '0' })),
      ...syntheticRows.map((row) => ({ ...row, is_synthetic: '1' })),
    ];

    const csvContent = Papa.unparse(augmentedRows, { columns: [...columnNames, 'is_synthetic'] });
    await mkdir(this.artifactDir, { recursive: true });
    const artifactId = `syn-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const baseName = sample.fileName.replace(/\.[^.]+$/, '') || 'dataset';
    const fileName = `${baseName}_synthetic_augmented.csv`;
    const filePath = join(this.artifactDir, `${artifactId}.csv`);
    await writeFile(filePath, csvContent, 'utf8');

    const artifact: SynthesisArtifactMeta = {
      artifactId,
      pipelineId,
      userId: actorUserId,
      fileName,
      filePath,
      originalRowCount: originalRows.length,
      syntheticRowCount: syntheticRows.length,
      totalRowCount: augmentedRows.length,
      targetColumn,
      minorityLabel,
      mode: synthesisOptions.mode ?? 'minority_only',
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifactId, artifact);
    await this.persistArtifactMeta(artifact);

    const ratioAfter = this.describeRatio(augmentedRows, targetColumn, minorityLabel);
    const constraintsApplied = constraintsText.split(', ').filter(Boolean);
    const synthesisVisuals: PipelineStepSynthesisVisuals = {
      mode: synthesisOptions.mode ?? 'minority_only',
      targetColumn,
      minorityLabel,
      originalMinorityCount: minorityCount,
      userSpecifiedRowCount: synthesisOptions.targetSyntheticCount ?? null,
      recommendedRowCount: targetSyntheticCount,
      actualSyntheticCount: syntheticRows.length,
      distributionBefore,
      distributionAfter: ratioAfter,
      constraintsApplied,
      strategySummary,
      recommendationRationale: recommendation.rationale,
    };

    return {
      summary: synthesisOptions.targetSyntheticCount
        ? `합성 완료: 사용자 지정 ${syntheticRows.length}행 생성 (${minorityLabel})`
        : `합성 완료: LLM 추천 ${recommendation.count}행 → ${syntheticRows.length}행 생성 (${minorityLabel})`,
      inputSummary: `${sample.fileName} · 원본 ${originalRows.length}행 · 모드 ${synthesisOptions.mode ?? 'minority_only'}`,
      evidence: [
        ...this.buildPriorEvidenceLines(input.context),
        `타깃 컬럼: ${targetColumn}`,
        `소수 클래스: ${minorityLabel} (원본 ${minorityCount}행)`,
        synthesisOptions.targetSyntheticCount
          ? `사용자 지정 생성: ${syntheticRows.length}행`
          : `LLM 추천 생성: ${recommendation.count}행 (${recommendation.rationale})`,
        `합성 전 분포: ${distributionBefore}`,
        `합성 후 분포: ${ratioAfter}`,
        ...subTaskResults.slice(0, 3).map((item) => `[${item.label}] ${item.summary}`),
      ].filter(Boolean),
      expectedResult: '다운로드한 CSV로 모델 재학습 또는 결과 비교 단계 진행',
      llmUsed: llmPlanUsed || rowLlmUsed,
      artifact,
      subTaskResults,
      synthesisVisuals,
    };
  }

  private readSynthesisExecution(context: Record<string, unknown> | null | undefined): {
    phase: 'full' | 'plan' | 'batch';
    artifactId?: string;
    planSnapshot?: SynthesisPlanSnapshot;
    generatedCount?: number;
    batchSize?: number;
  } {
    const raw = context?.synthesisExecution;
    if (!raw || typeof raw !== 'object') {
      return { phase: 'full' };
    }
    const execution = raw as Record<string, unknown>;
    const phase = execution.phase === 'plan' || execution.phase === 'batch'
      ? execution.phase
      : 'full';
    const planSnapshot = execution.planSnapshot && typeof execution.planSnapshot === 'object'
      ? execution.planSnapshot as SynthesisPlanSnapshot
      : undefined;
    const generatedCount = Number(execution.generatedCount);
    const batchSize = Number(execution.batchSize);
    return {
      phase,
      artifactId: typeof execution.artifactId === 'string' ? execution.artifactId : undefined,
      planSnapshot,
      generatedCount: Number.isFinite(generatedCount) && generatedCount >= 0
        ? Math.floor(generatedCount)
        : 0,
      batchSize: Number.isFinite(batchSize) && batchSize > 0
        ? Math.min(Math.floor(batchSize), SYNTHESIS_BATCH_SIZE)
        : SYNTHESIS_BATCH_SIZE,
    };
  }

  private async executeSynthesisPlanPhase(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      analysis?: DataSourceAnalysisResult | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<SynthesisGenerationResult> {
    const prepared = await this.prepareSynthesisContext(actorUserId, pipelineId, input);
    const {
      sample,
      originalRows,
      columnNames,
      analysis,
      synthesisOptions,
      targetColumn,
      minorityLabel,
      minorityCount,
      distributionBefore,
      recommendation,
      constraintsText,
      subTaskResults,
      strategySummary,
      llmPlanUsed,
      dataSourceId,
      mergeArtifactId,
      sourceKind,
    } = prepared;

    const targetSyntheticCount = synthesisOptions.targetSyntheticCount
      ? Math.min(synthesisOptions.targetSyntheticCount, 2000)
      : recommendation.count;

    const synthesisPlan: SynthesisPlanSnapshot = {
      dataSourceId,
      targetColumn,
      minorityLabel,
      minorityCount,
      columnNames,
      targetSyntheticCount,
      userSpecifiedRowCount: synthesisOptions.targetSyntheticCount ?? null,
      constraintsText,
      synthesisOptions,
      strategySummary,
      recommendationRationale: recommendation.rationale,
      distributionBefore,
      subTaskResults,
      sourceFileName: sample.fileName,
      originalRowCount: originalRows.length,
      mergeArtifactId: mergeArtifactId ?? null,
      sourceKind: sourceKind ?? 'original',
    };

    const constraintsApplied = constraintsText.split(', ').filter(Boolean);
    const synthesisVisuals: PipelineStepSynthesisVisuals = {
      mode: synthesisOptions.mode ?? 'domain_guided',
      targetColumn,
      minorityLabel,
      originalMinorityCount: minorityCount,
      userSpecifiedRowCount: synthesisOptions.targetSyntheticCount ?? null,
      recommendedRowCount: recommendation.count,
      actualSyntheticCount: 0,
      distributionBefore,
      distributionAfter: distributionBefore,
      constraintsApplied,
      strategySummary,
      recommendationRationale: recommendation.rationale,
    };

    return {
      summary: synthesisOptions.targetSyntheticCount
        ? `합성 설계 완료: ${targetSyntheticCount}행 생성 예정 (${minorityLabel})`
        : `합성 설계 완료: LLM 추천 ${targetSyntheticCount}행 생성 예정 (${minorityLabel})`,
      inputSummary: `${sample.fileName} · 원본 ${originalRows.length}행 · 생성 목표 ${targetSyntheticCount}행`,
      evidence: [
        ...this.buildPriorEvidenceLines(input.context),
        sourceKind === 'merged'
          ? `입력 데이터: 정합성 병합 CSV (${mergeArtifactId})`
          : '입력 데이터: 원본 CSV',
        `타깃 컬럼: ${targetColumn}`,
        `소수 클래스: ${minorityLabel} (원본 ${minorityCount}행)`,
        synthesisOptions.targetSyntheticCount
          ? `사용자 지정 생성: ${targetSyntheticCount}행`
          : `LLM 추천 생성: ${targetSyntheticCount}행 (${recommendation.rationale})`,
        `합성 전 분포: ${distributionBefore}`,
        `배치 생성: ${SYNTHESIS_BATCH_SIZE}행씩 분할`,
        ...subTaskResults.slice(0, 3).map((item) => `[${item.label}] ${item.summary}`),
      ].filter(Boolean),
      expectedResult: '설계를 확인한 뒤 합성 행을 배치 단위로 생성합니다.',
      llmUsed: llmPlanUsed,
      artifact: null,
      subTaskResults,
      synthesisVisuals,
      synthesisPlan,
      synthesisProgress: {
        generatedCount: 0,
        targetCount: targetSyntheticCount,
        currentBatch: 0,
        totalBatches: countSynthesisBatches(targetSyntheticCount),
        batchSize: SYNTHESIS_BATCH_SIZE,
        complete: false,
      },
    };
  }

  private async executeSynthesisBatchPhase(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      analysis?: DataSourceAnalysisResult | null;
      context?: Record<string, unknown> | null;
    },
    execution: {
      artifactId?: string;
      planSnapshot?: SynthesisPlanSnapshot;
      generatedCount?: number;
      batchSize?: number;
    },
  ): Promise<SynthesisGenerationResult> {
    const plan = execution.planSnapshot;
    if (!plan?.dataSourceId || !plan.columnNames?.length) {
      throw new BadRequestException('합성 배치 생성을 위해 plan 스냅샷이 필요합니다.');
    }

    const generatedSoFar = execution.generatedCount ?? 0;
    const targetCount = plan.targetSyntheticCount;
    if (generatedSoFar >= targetCount) {
      throw new BadRequestException('이미 목표 생성 행 수에 도달했습니다.');
    }

    const batchSize = execution.batchSize ?? SYNTHESIS_BATCH_SIZE;
    const requestCount = Math.min(batchSize, targetCount - generatedSoFar);

    const { originalRows, columnNames } = await this.loadRowsFromPlan(actorUserId, pipelineId, plan);
    const allMinorityRows = originalRows
      .filter((row) => String(row[plan.targetColumn] ?? '').trim() === plan.minorityLabel);
    const currentBatchIndex = countCompletedBatches(generatedSoFar, batchSize) + 1;
    const totalBatches = countSynthesisBatches(targetCount, batchSize);
    const diversitySeed = `${pipelineId}:batch:${currentBatchIndex}:${generatedSoFar}`;
    const minorityExamples = this.pickDiverseMinorityExamples(allMinorityRows, 25, diversitySeed);

    let priorSyntheticRows: Record<string, string>[] = [];
    if (execution.artifactId) {
      try {
        const existing = await this.getArtifact(pipelineId, execution.artifactId, actorUserId);
        const augmented = await this.readAugmentedRows(existing);
        priorSyntheticRows = augmented
          .filter((row) => String(row.is_synthetic ?? '').trim() === '1')
          .slice(-40);
      } catch {
        priorSyntheticRows = [];
      }
    }

    const analysis = input.analysis ?? null;
    const syntheticRows = await this.generateRows({
      columnNames: plan.columnNames,
      targetColumn: plan.targetColumn,
      minorityLabel: plan.minorityLabel,
      minorityExamples,
      targetCount: requestCount,
      analysis,
      synthesisOptions: plan.synthesisOptions,
      constraintsText: plan.constraintsText,
      context: input.context ?? null,
      batchIndex: currentBatchIndex,
      totalBatches,
      generatedSoFar: generatedSoFar,
      priorSyntheticRows,
      diversitySeed,
    });

    const artifact = await this.writeOrAppendArtifact({
      actorUserId,
      pipelineId,
      artifactId: execution.artifactId,
      originalRows,
      columnNames: plan.columnNames,
      fileName: plan.sourceFileName,
      newSyntheticRows: syntheticRows,
      plan,
    });

    const generatedCount = generatedSoFar + syntheticRows.length;
    const complete = generatedCount >= targetCount;
    const totalBatchesFinal = countSynthesisBatches(targetCount, batchSize);
    const currentBatch = countCompletedBatches(generatedCount, batchSize);
    const augmentedRows = await this.readAugmentedRows(artifact);
    const ratioAfter = this.describeRatio(augmentedRows, plan.targetColumn, plan.minorityLabel);
    const constraintsApplied = plan.constraintsText.split(', ').filter(Boolean);
    const synthesisVisuals: PipelineStepSynthesisVisuals = {
      mode: plan.synthesisOptions.mode ?? 'domain_guided',
      targetColumn: plan.targetColumn,
      minorityLabel: plan.minorityLabel,
      originalMinorityCount: plan.minorityCount,
      userSpecifiedRowCount: plan.userSpecifiedRowCount,
      recommendedRowCount: plan.targetSyntheticCount,
      actualSyntheticCount: generatedCount,
      distributionBefore: plan.distributionBefore,
      distributionAfter: ratioAfter,
      constraintsApplied,
      strategySummary: plan.strategySummary,
      recommendationRationale: plan.recommendationRationale,
    };

    return {
      summary: complete
        ? `합성 완료: 배치 ${currentBatch}/${totalBatchesFinal} · ${generatedCount}행 생성 (${plan.minorityLabel})`
        : `배치 ${currentBatch}/${totalBatchesFinal} 완료 · 합성 ${generatedCount}/${targetCount}행`,
      inputSummary: `${plan.sourceFileName} · 원본 ${plan.originalRowCount}행 · 배치 ${currentBatch}/${totalBatchesFinal} · 합성 ${generatedCount}/${targetCount}행`,
      evidence: [
        `타깃 컬럼: ${plan.targetColumn}`,
        `소수 클래스: ${plan.minorityLabel} (원본 ${plan.minorityCount}행)`,
        plan.userSpecifiedRowCount
          ? `사용자 지정 생성: ${targetCount}행`
          : `LLM 추천 생성: ${targetCount}행`,
        `배치 ${currentBatch}/${totalBatchesFinal}: 이번 ${syntheticRows.length}행 (누적 ${generatedCount}행)`,
        complete ? `합성 후 분포: ${ratioAfter}` : `다음 배치는 다른 예시·시드로 생성됩니다`,
      ],
      expectedResult: complete
        ? '다운로드한 CSV로 모델 재학습 또는 결과 비교 단계 진행'
        : '다음 배치 생성을 계속합니다.',
      llmUsed: this.llmClient.isConfigured(),
      artifact,
      subTaskResults: plan.subTaskResults,
      synthesisVisuals,
      synthesisPlan: plan,
      synthesisProgress: {
        generatedCount,
        targetCount,
        currentBatch,
        totalBatches: totalBatchesFinal,
        batchSize,
        complete,
      },
    };
  }

  private pickDiverseMinorityExamples(
    rows: Record<string, string>[],
    count: number,
    seed: string,
  ): Record<string, string>[] {
    if (!rows.length || count <= 0) return [];
    const shuffled = shuffleWithSeed(rows, seed);
    const picked: Record<string, string>[] = [];
    for (let index = 0; index < count; index += 1) {
      picked.push(shuffled[index % shuffled.length]);
    }
    return picked;
  }

  private rowFingerprint(row: Record<string, string>, columnNames: string[]): string {
    return columnNames
      .filter((column) => column !== 'is_synthetic')
      .map((column) => String(row[column] ?? '').trim())
      .join('\u001f');
  }

  private filterUniqueRows(
    rows: Record<string, string>[],
    columnNames: string[],
    seen: Set<string>,
  ): Record<string, string>[] {
    const unique: Record<string, string>[] = [];
    for (const row of rows) {
      const fingerprint = this.rowFingerprint(row, columnNames);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      unique.push(row);
    }
    return unique;
  }

  private seedSeenFingerprints(
    rows: Record<string, string>[],
    columnNames: string[],
  ): Set<string> {
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(this.rowFingerprint(row, columnNames));
    }
    return seen;
  }

  private async prepareSynthesisContext(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      analysis?: DataSourceAnalysisResult | null;
      context?: Record<string, unknown> | null;
    },
  ) {
    const loaded = await this.loadSynthesisSourceDataset(actorUserId, pipelineId, input);
    const { sample, originalRows, columnNames, dataSourceId, mergeArtifactId, sourceKind } = loaded;
    if (!originalRows.length) {
      throw new BadRequestException('원본 CSV에 데이터 행이 없습니다.');
    }

    const analysis = input.analysis ?? null;
    const ctx = input.context ?? null;
    const synthesisOptions = this.readSynthesisOptions(ctx);
    const selectedAddonIds = this.resolveSelectedAddonIds(ctx);
    const { targetColumn, minorityLabel } = this.resolveSynthesisTargets(
      columnNames,
      analysis,
      ctx,
      originalRows,
    );
    const distribution = this.countDistribution(originalRows, targetColumn);
    const minorityCount = distribution[minorityLabel] ?? 0;
    const distributionBefore = this.describeDistribution(distribution, minorityLabel, originalRows.length);

    const recommendation = await this.resolveSyntheticRowCount({
      synthesisOptions,
      minorityCount,
      distribution,
      minorityLabel,
      analysis,
      context: ctx,
    });

    const constraintsText = this.buildConstraintsText(synthesisOptions);
    const codeSubTasks = this.runCodeBasedSubTasks(
      selectedAddonIds,
      synthesisOptions,
      minorityLabel,
      minorityCount,
      recommendation.count,
      constraintsText,
      ctx,
    );

    let subTaskResults = codeSubTasks;
    let strategySummary = recommendation.rationale;
    let llmPlanUsed = false;

    if (this.llmClient.isConfigured()) {
      try {
        const llmPlan = await this.requestLlmSynthesisPlan({
          selectedAddonIds,
          synthesisOptions,
          columnNames,
          targetColumn,
          minorityLabel,
          minorityCount,
          distribution,
          recommendedCount: recommendation.count,
          userSpecifiedCount: synthesisOptions.targetSyntheticCount ?? null,
          analysis,
          constraintsText,
          minorityExamples: originalRows
            .filter((row) => String(row[targetColumn] ?? '').trim() === minorityLabel)
            .slice(0, 8),
          context: input.context ?? null,
        });
        subTaskResults = this.mergeSubTaskResults(codeSubTasks, llmPlan.subTaskResults);
        if (llmPlan.strategySummary) strategySummary = llmPlan.strategySummary;
        if (!synthesisOptions.targetSyntheticCount && llmPlan.recommendedRowCount > 0) {
          recommendation.count = llmPlan.recommendedRowCount;
          recommendation.rationale = llmPlan.recommendationRationale || recommendation.rationale;
        }
        llmPlanUsed = true;
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    return {
      dataSourceId,
      sample,
      originalRows,
      columnNames,
      analysis,
      synthesisOptions,
      targetColumn,
      minorityLabel,
      minorityCount,
      distributionBefore,
      recommendation,
      constraintsText,
      subTaskResults,
      strategySummary,
      llmPlanUsed,
      mergeArtifactId,
      sourceKind,
    };
  }

  private async loadSynthesisSourceDataset(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      context?: Record<string, unknown> | null;
    },
  ) {
    const ctx = input.context ?? {};
    const mergeFromContext = (ctx.matchingMergeArtifact ?? ctx.mergeArtifact) as
      | { artifactId?: string }
      | null
      | undefined;
    const mergeArtifactId = mergeFromContext?.artifactId?.trim() || null;

    if (mergeArtifactId) {
      const { artifact, content } = await this.mergeService.readArtifactContent(
        pipelineId,
        mergeArtifactId,
        actorUserId,
      );
      const parsed = Papa.parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
      });
      const originalRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
      const columnNames = parsed.meta.fields?.filter(Boolean) ?? Object.keys(originalRows[0] ?? {});
      return {
        dataSourceId: input.dataSourceId?.trim() || '',
        sample: { fileName: artifact.fileName, content: Buffer.from(content, 'utf8') },
        originalRows,
        columnNames,
        mergeArtifactId,
        sourceKind: 'merged' as const,
      };
    }

    const dataSourceId = input.dataSourceId?.trim();
    if (!dataSourceId) {
      throw new BadRequestException('합성을 위해 연결된 데이터 소스가 필요합니다.');
    }

    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('합성할 원본 CSV 파일이 없습니다.');
    }

    const parsed = Papa.parse<Record<string, string>>(sample.content.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    const originalRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    const columnNames = parsed.meta.fields?.filter(Boolean) ?? Object.keys(originalRows[0] ?? {});

    return {
      dataSourceId,
      sample,
      originalRows,
      columnNames,
      mergeArtifactId: null,
      sourceKind: 'original' as const,
    };
  }

  private async loadRowsFromPlan(
    actorUserId: string,
    pipelineId: string,
    plan: SynthesisPlanSnapshot,
  ) {
    if (plan.mergeArtifactId) {
      const { content } = await this.mergeService.readArtifactContent(
        pipelineId,
        plan.mergeArtifactId,
        actorUserId,
      );
      const parsed = Papa.parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
      });
      const originalRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
      const columnNames = parsed.meta.fields?.filter(Boolean) ?? plan.columnNames;
      return { originalRows, columnNames };
    }

    const sample = await this.storeService.getPrimaryDataSourceFileContent(plan.dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('합성할 원본 CSV 파일이 없습니다.');
    }
    const parsed = Papa.parse<Record<string, string>>(sample.content.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    const originalRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    const columnNames = parsed.meta.fields?.filter(Boolean) ?? plan.columnNames;
    return { originalRows, columnNames };
  }

  private async writeOrAppendArtifact(input: {
    actorUserId: string;
    pipelineId: string;
    artifactId?: string;
    originalRows: Record<string, string>[];
    columnNames: string[];
    fileName: string;
    newSyntheticRows: Record<string, string>[];
    plan: SynthesisPlanSnapshot;
  }): Promise<SynthesisArtifactMeta> {
    const outputColumns = [...input.columnNames, 'is_synthetic'];
    const markedSynthetic = input.newSyntheticRows.map((row) => ({ ...row, is_synthetic: '1' }));

    if (!input.artifactId) {
      const augmentedRows = [
        ...input.originalRows.map((row) => ({ ...row, is_synthetic: '0' })),
        ...markedSynthetic,
      ];
      return this.persistArtifact({
        actorUserId: input.actorUserId,
        pipelineId: input.pipelineId,
        fileName: input.fileName,
        augmentedRows,
        outputColumns,
        originalRowCount: input.originalRows.length,
        syntheticRowCount: markedSynthetic.length,
        targetColumn: input.plan.targetColumn,
        minorityLabel: input.plan.minorityLabel,
        mode: input.plan.synthesisOptions.mode ?? 'domain_guided',
      });
    }

    const existing = await this.getArtifact(input.pipelineId, input.artifactId, input.actorUserId);
    const content = await readFile(existing.filePath, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
    });
    const currentRows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    const augmentedRows = [...currentRows, ...markedSynthetic];
    const csvContent = Papa.unparse(augmentedRows, { columns: outputColumns });
    await writeFile(existing.filePath, csvContent, 'utf8');

    const updated: SynthesisArtifactMeta = {
      ...existing,
      syntheticRowCount: existing.syntheticRowCount + markedSynthetic.length,
      totalRowCount: existing.originalRowCount + existing.syntheticRowCount + markedSynthetic.length,
    };
    this.artifacts.set(existing.artifactId, updated);
    await this.persistArtifactMeta(updated);
    return updated;
  }

  private async persistArtifact(input: {
    actorUserId: string;
    pipelineId: string;
    fileName: string;
    augmentedRows: Record<string, string>[];
    outputColumns: string[];
    originalRowCount: number;
    syntheticRowCount: number;
    targetColumn: string;
    minorityLabel: string;
    mode: string;
  }): Promise<SynthesisArtifactMeta> {
    const csvContent = Papa.unparse(input.augmentedRows, { columns: input.outputColumns });
    await mkdir(this.artifactDir, { recursive: true });
    const artifactId = `syn-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const baseName = input.fileName.replace(/\.[^.]+$/, '') || 'dataset';
    const fileName = `${baseName}_synthetic_augmented.csv`;
    const filePath = join(this.artifactDir, `${artifactId}.csv`);
    await writeFile(filePath, csvContent, 'utf8');

    const artifact: SynthesisArtifactMeta = {
      artifactId,
      pipelineId: input.pipelineId,
      userId: input.actorUserId,
      fileName,
      filePath,
      originalRowCount: input.originalRowCount,
      syntheticRowCount: input.syntheticRowCount,
      totalRowCount: input.augmentedRows.length,
      targetColumn: input.targetColumn,
      minorityLabel: input.minorityLabel,
      mode: input.mode,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifactId, artifact);
    await this.persistArtifactMeta(artifact);
    return artifact;
  }

  private async readAugmentedRows(artifact: SynthesisArtifactMeta): Promise<Record<string, string>[]> {
    const content = await readFile(artifact.filePath, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
    });
    return (parsed.data ?? []).filter((row) => row && typeof row === 'object');
  }

  private resolveSelectedAddonIds(context: Record<string, unknown> | null | undefined): string[] {
    const raw = context?.selectedAddonIds;
    const ids = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter((id) => SYNTHESIS_ADDON_CATALOG[id])
      : [];
    return ids.length > 0 ? ids : DEFAULT_SYNTHESIS_ADDON_IDS;
  }

  private readSynthesisOptions(context: Record<string, unknown> | null | undefined): SynthesisOptions {
    const raw = context?.synthesisOptions;
    if (!raw || typeof raw !== 'object') {
      return { mode: 'domain_guided', targetSyntheticCount: null, constraints: {} };
    }
    const options = raw as SynthesisOptions;
    const countRaw = options.targetSyntheticCount;
    const count = typeof countRaw === 'string' ? Number(countRaw) : countRaw;
    return {
      mode: typeof options.mode === 'string' ? options.mode : 'domain_guided',
      targetSyntheticCount: typeof count === 'number' && Number.isFinite(count) && count > 0
        ? Math.floor(count)
        : null,
      constraints: options.constraints && typeof options.constraints === 'object'
        ? options.constraints
        : {},
    };
  }

  private async resolveSyntheticRowCount(input: {
    synthesisOptions: SynthesisOptions;
    minorityCount: number;
    distribution: Record<string, number>;
    minorityLabel: string;
    analysis: DataSourceAnalysisResult | null;
    context: Record<string, unknown> | null;
  }): Promise<{ count: number; rationale: string }> {
    if (input.synthesisOptions.targetSyntheticCount) {
      return {
        count: Math.min(input.synthesisOptions.targetSyntheticCount, 2000),
        rationale: '사용자가 지정한 생성 행 수',
      };
    }

    const heuristic = this.computeTargetSyntheticCount(
      input.synthesisOptions.mode,
      input.minorityCount,
      input.distribution,
      input.minorityLabel,
    );

    if (!this.llmClient.isConfigured()) {
      return {
        count: heuristic,
        rationale: `휴리스틱 추천: 소수 클래스 ${input.minorityCount}행 기준 ${input.synthesisOptions.mode ?? 'minority_only'} 모드`,
      };
    }

    try {
      const total = Object.values(input.distribution).reduce((sum, value) => sum + value, 0);
      const minorityRatio = total > 0 ? (input.minorityCount / total) * 100 : 0;
      const raw = await this.llmClient.requestJson({
        schemaName: 'pipeline_synthesis_row_recommendation',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recommended_row_count: { type: 'number' },
            rationale: { type: 'string' },
          },
          required: ['recommended_row_count', 'rationale'],
        },
        systemPrompt: 'Recommend synthetic row count for minority-class augmentation in clinical ML. Respond in Korean for rationale.',
        userPrompt: [
          `Mode: ${input.synthesisOptions.mode ?? 'minority_only'}`,
          `Target minority label: ${input.minorityLabel}`,
          `Original minority count: ${input.minorityCount}`,
          `Total rows: ${total}`,
          `Minority ratio: ${minorityRatio.toFixed(2)}%`,
          `Distribution: ${JSON.stringify(input.distribution)}`,
          `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
          `ML task: ${input.analysis?.domainForm?.ml_task ?? ''}`,
          'Prior step context:',
          this.buildPriorContextDigest(input.context),
          `Matching review: ${JSON.stringify(input.context?.matchingReview ?? {})}`,
          'Recommend a practical synthetic row count between 10 and 2000.',
        ].join('\n'),
      });
      const payload = JSON.parse(raw) as { recommended_row_count?: number; rationale?: string };
      const count = Math.min(
        2000,
        Math.max(10, Math.floor(Number(payload.recommended_row_count) || heuristic)),
      );
      return {
        count,
        rationale: String(payload.rationale ?? '').trim()
          || `LLM 추천: 소수 비율 ${minorityRatio.toFixed(1)}% 보완`,
      };
    } catch {
      return {
        count: heuristic,
        rationale: `휴리스틱 추천: 소수 클래스 ${input.minorityCount}행 기준`,
      };
    }
  }

  private runCodeBasedSubTasks(
    addonIds: string[],
    options: SynthesisOptions,
    minorityLabel: string,
    minorityCount: number,
    recommendedCount: number,
    constraintsText: string,
    context: Record<string, unknown> | null | undefined,
  ): SynthesisSubTaskResult[] {
    const domainVisuals = context?.domainVisuals as {
      anomalySubtypes?: string[];
      predictionHorizon?: { observation?: string };
      targetColumn?: string;
      targetLabel?: string;
    } | null;
    const matchingReview = context?.matchingReview as { finalFit?: string; summary?: string } | null;
    const qualityCheck = context?.qualityCheck as { overallVerdict?: string } | null;
    const priorSummaries = context?.priorSummaries as Record<string, string> | undefined;
    const priorNote = [
      priorSummaries?.diagnosis ? `진단: ${priorSummaries.diagnosis}` : '',
      priorSummaries?.domain ? `도메인: ${priorSummaries.domain}` : '',
      priorSummaries?.matching ? `정합성: ${priorSummaries.matching}` : '',
      matchingReview?.finalFit ? `정합성 판정 ${matchingReview.finalFit}` : '',
      qualityCheck?.overallVerdict ? `품질 ${qualityCheck.overallVerdict}` : '',
    ].filter(Boolean).join(' · ');

    return addonIds.map((id) => {
      const meta = SYNTHESIS_ADDON_CATALOG[id];
      if (id === 'addon_syn_strategy_recommend') {
        const strategyLabel = options.targetSyntheticCount
          ? `사용자 지정 ${options.targetSyntheticCount}행`
          : `LLM 추천 ${recommendedCount}행`;
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: priorNote
            ? `이전 단계 반영 · ${strategyLabel}`
            : `도메인·진단·정합성 기반 보완 전략 · ${strategyLabel}`,
          findings: [
            priorNote || '이전 단계 요약 미연결 — 기본 휴리스틱 적용',
            minorityCount < 50 ? '소수 클래스가 매우 적어 합성 보완 권장' : '소수 클래스 보완 필요',
            `대상 라벨: ${minorityLabel} (${minorityCount}행)`,
            domainVisuals?.targetColumn ? `도메인 타깃 컬럼: ${domainVisuals.targetColumn}` : '',
            strategyLabel,
          ].filter(Boolean),
        };
      }
      if (id === 'addon_syn_anomaly_generation_conditions') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `${minorityLabel} 이상 샘플 ${recommendedCount}건 생성 조건`,
          findings: [
            `생성 비율: 원본 소수 ${minorityCount} → +${recommendedCount}`,
            `제외: 비현실적 조합 ${options.constraints?.excludeUnrealisticSamples ? '적용' : '미적용'}`,
          ],
        };
      }
      if (id === 'addon_syn_domain_constraint_rules') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `제약: ${constraintsText}`,
          findings: [
            options.constraints?.preserveLabelSemantics ? '라벨 의미 보존' : '',
            options.constraints?.preserveFeatureRanges ? '피처 범위 보존' : '',
            domainVisuals?.targetLabel ? `도메인 타깃 라벨: ${domainVisuals.targetLabel}` : '',
            domainVisuals?.anomalySubtypes?.length
              ? `이상 유형: ${domainVisuals.anomalySubtypes.slice(0, 3).join(', ')}`
              : '',
            matchingReview?.finalFit ? `정합성 검토: ${matchingReview.finalFit}` : '',
          ].filter(Boolean),
        };
      }
      if (id === 'addon_syn_timeseries_anomaly_patterns') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: domainVisuals?.predictionHorizon?.observation
            ? `관찰 구간 반영: ${domainVisuals.predictionHorizon.observation}`
            : '시계열 이상 패턴 초안',
          findings: ['급격한 악화', '점진적 악화', '회복 후 재악화'],
        };
      }
      if (id === 'addon_syn_method_comparison') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: 'LLM 기반 행 생성 + 통계 부트스트랩 fallback',
          findings: ['1순위: LLM 생성', '2순위: 소수 샘플 부트스트랩', `모드: ${options.mode ?? 'minority_only'}`],
        };
      }
      return {
        id,
        label: meta?.label ?? id,
        status: 'done',
        summary: '기본 점검 완료',
        findings: [],
      };
    });
  }

  private async requestLlmSynthesisPlan(input: {
    selectedAddonIds: string[];
    synthesisOptions: SynthesisOptions;
    columnNames: string[];
    targetColumn: string;
    minorityLabel: string;
    minorityCount: number;
    distribution: Record<string, number>;
    recommendedCount: number;
    userSpecifiedCount: number | null;
    analysis: DataSourceAnalysisResult | null;
    constraintsText: string;
    minorityExamples: Record<string, string>[];
    context: Record<string, unknown> | null;
  }): Promise<{
    subTaskResults: SynthesisSubTaskResult[];
    recommendedRowCount: number;
    recommendationRationale: string;
    strategySummary: string;
  }> {
    const addonPrompt = input.selectedAddonIds.map((id) => {
      const meta = SYNTHESIS_ADDON_CATALOG[id];
      return `- ${id}: ${meta?.label ?? id} — ${meta?.description ?? ''}`;
    }).join('\n');

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_synthesis_execution',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recommended_row_count: { type: 'number' },
          recommendation_rationale: { type: 'string' },
          strategy_summary: { type: 'string' },
          sub_tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                addon_id: { type: 'string' },
                summary: { type: 'string' },
                findings: { type: 'array', items: { type: 'string' } },
                status: { type: 'string', enum: ['done', 'failed'] },
              },
              required: ['addon_id', 'summary', 'findings', 'status'],
            },
          },
        },
        required: ['recommended_row_count', 'recommendation_rationale', 'strategy_summary', 'sub_tasks'],
      },
      systemPrompt: [
        'You design synthetic data augmentation for clinical ML pipelines.',
        'Use prior diagnosis, domain, and matching context.',
        'If user did not specify row count, recommend a practical synthetic row count.',
        'Respond in Korean.',
      ].join(' '),
      userPrompt: [
        `Mode: ${input.synthesisOptions.mode ?? 'minority_only'}`,
        `User specified row count: ${input.userSpecifiedCount ?? '(none — recommend)'}`,
        `Heuristic recommendation: ${input.recommendedCount}`,
        `Target: ${input.targetColumn} = ${input.minorityLabel} (${input.minorityCount} rows)`,
        `Distribution: ${JSON.stringify(input.distribution)}`,
        `Constraints: ${input.constraintsText}`,
        `Columns: ${input.columnNames.join(', ')}`,
        'Domain form:',
        JSON.stringify(input.analysis?.domainForm ?? input.context?.domainForm ?? {}, null, 2),
        'Domain visuals:',
        JSON.stringify(input.context?.domainVisuals ?? {}, null, 2),
        'Diagnosis visuals:',
        JSON.stringify(input.context?.diagnosisVisuals ?? {}, null, 2),
        'Matching review:',
        JSON.stringify(input.context?.matchingReview ?? {}, null, 2),
        'Prior step digest:',
        this.buildPriorContextDigest(input.context),
        `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
        'Minority examples:',
        JSON.stringify(input.minorityExamples, null, 2),
        'Sub-tasks:',
        addonPrompt,
      ].join('\n'),
    });

    const payload = JSON.parse(raw) as {
      recommended_row_count?: number;
      recommendation_rationale?: string;
      strategy_summary?: string;
      sub_tasks?: Array<{ addon_id?: string; summary?: string; findings?: string[]; status?: string }>;
    };

    const subTaskResults = (payload.sub_tasks ?? [])
      .filter((item) => item?.addon_id && SYNTHESIS_ADDON_CATALOG[item.addon_id])
      .map((item) => ({
        id: String(item.addon_id),
        label: SYNTHESIS_ADDON_CATALOG[String(item.addon_id)].label,
        status: item.status === 'failed' ? 'failed' as const : 'done' as const,
        summary: String(item.summary ?? '').trim() || '분석 완료',
        findings: Array.isArray(item.findings) ? item.findings.map(String).filter(Boolean) : [],
      }));

    return {
      subTaskResults,
      recommendedRowCount: Math.min(
        2000,
        Math.max(10, Math.floor(Number(payload.recommended_row_count) || input.recommendedCount)),
      ),
      recommendationRationale: String(payload.recommendation_rationale ?? '').trim(),
      strategySummary: String(payload.strategy_summary ?? '').trim(),
    };
  }

  private mergeSubTaskResults(
    codeResults: SynthesisSubTaskResult[],
    llmResults: SynthesisSubTaskResult[],
  ): SynthesisSubTaskResult[] {
    const llmById = new Map(llmResults.map((item) => [item.id, item]));
    return codeResults.map((code) => {
      const llm = llmById.get(code.id);
      if (!llm) return code;
      return {
        ...code,
        summary: llm.summary || code.summary,
        findings: llm.findings.length ? llm.findings : code.findings,
        status: llm.status,
      };
    });
  }

  private describeDistribution(
    distribution: Record<string, number>,
    minorityLabel: string,
    total: number,
  ): string {
    const minority = distribution[minorityLabel] ?? 0;
    const majority = Math.max(0, total - minority);
    return `${minorityLabel} ${minority} / 기타 ${majority} (총 ${total}행)`;
  }

  private buildPriorEvidenceLines(context: Record<string, unknown> | null | undefined): string[] {
    if (!context) return [];
    const lines: string[] = [];
    const summaries = context.priorSummaries as Record<string, string> | undefined;
    if (summaries?.diagnosis?.trim()) {
      lines.push(`[진단] ${summaries.diagnosis.trim()}`);
    }
    if (summaries?.domain?.trim()) {
      lines.push(`[도메인] ${summaries.domain.trim()}`);
    }
    if (summaries?.matching?.trim()) {
      lines.push(`[정합성] ${summaries.matching.trim()}`);
    }
    const matchingReview = context.matchingReview as { finalFit?: string } | null;
    if (matchingReview?.finalFit?.trim()) {
      lines.push(`정합성 판정: ${matchingReview.finalFit.trim()}`);
    }
    const qualityCheck = context.qualityCheck as { overallVerdict?: string } | null;
    if (qualityCheck?.overallVerdict?.trim()) {
      lines.push(`진단 품질: ${qualityCheck.overallVerdict.trim()}`);
    }
    const domainVisuals = context.domainVisuals as { targetColumn?: string; targetLabel?: string } | null;
    if (domainVisuals?.targetColumn?.trim()) {
      lines.push(`도메인 타깃 컬럼: ${domainVisuals.targetColumn.trim()}`);
    }
    return lines.slice(0, 5);
  }

  private buildPriorContextDigest(context: Record<string, unknown> | null | undefined): string {
    if (!context) return '';
    const parts: string[] = [];
    const summaries = context.priorSummaries as Record<string, string> | undefined;
    if (summaries?.diagnosis) parts.push(`진단 요약: ${summaries.diagnosis}`);
    if (summaries?.domain) parts.push(`도메인 요약: ${summaries.domain}`);
    if (summaries?.matching) parts.push(`정합성 요약: ${summaries.matching}`);

    const priorEvidence = context.priorEvidence as Record<string, string[]> | undefined;
    for (const [key, items] of Object.entries(priorEvidence ?? {})) {
      const slice = (items ?? []).slice(0, 2);
      if (slice.length) parts.push(`${key} evidence: ${slice.join(' · ')}`);
    }

    for (const field of ['diagnosisSubTaskResults', 'domainSubTaskResults', 'matchingSubTaskResults'] as const) {
      const results = context[field] as SynthesisSubTaskResult[] | undefined;
      const slice = (results ?? []).slice(0, 2).map((item) => `[${item.label}] ${item.summary}`);
      if (slice.length) parts.push(slice.join(' · '));
    }

    return parts.join('\n');
  }

  private resolveSynthesisTargets(
    columnNames: string[],
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null | undefined,
    originalRows: Record<string, string>[],
  ): { targetColumn: string; minorityLabel: string } {
    const domainVisuals = context?.domainVisuals as { targetColumn?: string; targetLabel?: string } | null;
    const diagnosisVisuals = context?.diagnosisVisuals as { targetColumn?: string } | null;
    const preferredColumn = domainVisuals?.targetColumn
      ?? diagnosisVisuals?.targetColumn
      ?? analysis?.targetColumn
      ?? null;
    const targetColumn = this.resolveTargetColumn(columnNames, analysis, preferredColumn);
    const distribution = this.countDistribution(originalRows, targetColumn);
    const preferredLabel = domainVisuals?.targetLabel ?? analysis?.targetLabel ?? null;
    const minorityLabel = this.resolveMinorityLabel(analysis, distribution, preferredLabel);
    return { targetColumn, minorityLabel };
  }

  private resolveTargetColumn(
    columnNames: string[],
    analysis: DataSourceAnalysisResult | null,
    preferredColumn?: string | null,
  ): string {
    const preferred = preferredColumn?.trim();
    if (preferred && columnNames.includes(preferred)) {
      return preferred;
    }
    const explicit = analysis?.targetColumn?.trim();
    if (explicit && columnNames.includes(explicit)) {
      return explicit;
    }
    const targetEvent = analysis?.domainForm?.target_event?.trim() ?? '';
    const eqMatch = targetEvent.match(/^([A-Za-z0-9_]+)\s*=/);
    if (eqMatch?.[1] && columnNames.includes(eqMatch[1])) {
      return eqMatch[1];
    }
    const included = columnNames.find((column) => targetEvent.includes(column));
    if (included) return included;
    const heuristic = columnNames.find((column) => /label|target|class|result|outcome|flag/i.test(column));
    return heuristic ?? columnNames[columnNames.length - 1];
  }

  private resolveMinorityLabel(
    analysis: DataSourceAnalysisResult | null,
    distribution: Record<string, number>,
    preferredLabel?: string | null,
  ): string {
    const preferred = preferredLabel?.trim();
    if (preferred && distribution[preferred] !== undefined) {
      return preferred;
    }
    const explicit = analysis?.targetLabel?.trim();
    if (explicit && distribution[explicit] !== undefined) {
      return explicit;
    }
    const targetEvent = analysis?.domainForm?.target_event ?? '';
    const valueMatch = targetEvent.match(/=\s*['"]?([^'"]+)['"]?/);
    if (valueMatch?.[1] && distribution[valueMatch[1]] !== undefined) {
      return valueMatch[1];
    }
    const meaningful = Object.entries(distribution)
      .filter(([label]) => label && !['UNKNOWN', 'unknown', '', 'null', 'NULL'].includes(label));
    const sorted = (meaningful.length ? meaningful : Object.entries(distribution))
      .sort((a, b) => a[1] - b[1]);
    return sorted[0]?.[0] ?? 'positive';
  }

  private countDistribution(rows: Record<string, string>[], targetColumn: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = String(row[targetColumn] ?? 'UNKNOWN').trim() || 'UNKNOWN';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private computeTargetSyntheticCount(
    mode: string | undefined,
    minorityCount: number,
    distribution: Record<string, number>,
    minorityLabel: string,
  ): number {
    const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
    if (mode === 'balanced_augmentation') {
      const majorityCount = Math.max(...Object.values(distribution));
      const targetMinority = Math.max(1, Math.floor(majorityCount / 9));
      return Math.min(Math.max(0, targetMinority - minorityCount), 2000);
    }
    if (mode === 'subgroup_targeted') {
      return Math.min(Math.max(50, Math.floor(minorityCount * 2)), 1000);
    }
    // minority_only: 5x expansion → add 4x minority rows
    const desiredTotal = Math.max(minorityCount * 5, minorityCount + 50);
    return Math.min(Math.max(0, desiredTotal - minorityCount), 2000);
  }

  private buildConstraintsText(options: SynthesisOptions): string {
    const constraints = options.constraints ?? {};
    const parts: string[] = [];
    if (constraints.preserveLabelSemantics) parts.push('라벨 의미 보존');
    if (constraints.preserveFeatureRanges) parts.push('피처 값 범위 보존');
    if (constraints.excludeUnrealisticSamples) parts.push('비현실적 조합 제외');
    return parts.join(', ') || '기본 제약';
  }

  private async generateRows(input: {
    columnNames: string[];
    targetColumn: string;
    minorityLabel: string;
    minorityExamples: Record<string, string>[];
    targetCount: number;
    analysis: DataSourceAnalysisResult | null;
    synthesisOptions: SynthesisOptions;
    constraintsText: string;
    context?: Record<string, unknown> | null;
    batchIndex?: number;
    totalBatches?: number;
    generatedSoFar?: number;
    priorSyntheticRows?: Record<string, string>[];
    diversitySeed?: string;
  }): Promise<Record<string, string>[]> {
    if (input.targetCount <= 0) {
      return [];
    }

    const chunkSize = 25;
    const generated: Record<string, string>[] = [];
    const llmConfigured = this.llmClient.isConfigured();
    const diversitySeed = input.diversitySeed ?? `synthesis:${input.batchIndex ?? 1}:${input.generatedSoFar ?? 0}`;
    const startOffset = input.generatedSoFar ?? 0;
    const seen = this.seedSeenFingerprints(input.priorSyntheticRows ?? [], input.columnNames);

    while (generated.length < input.targetCount) {
      const remaining = input.targetCount - generated.length;
      const requestCount = Math.min(chunkSize, remaining);
      const chunkIndex = Math.floor((startOffset + generated.length) / chunkSize);

      if (llmConfigured) {
        try {
          const batch = await this.requestLlmRows({
            ...input,
            requestCount,
            diversitySeed: `${diversitySeed}:chunk:${chunkIndex}`,
            priorSyntheticRows: [
              ...(input.priorSyntheticRows ?? []),
              ...generated,
            ].slice(-20),
          });
          const uniqueBatch = this.filterUniqueRows(batch, input.columnNames, seen);
          generated.push(...uniqueBatch.slice(0, requestCount));
          if (uniqueBatch.length > 0) continue;
        } catch {
          // statistical fallback below
        }
      }

      const fallback = this.bootstrapRows(
        input.minorityExamples,
        input.columnNames,
        input.targetColumn,
        input.minorityLabel,
        requestCount,
        {
          startOffset: startOffset + generated.length,
          diversitySeed: `${diversitySeed}:fallback:${chunkIndex}`,
          seen,
        },
      );
      const uniqueFallback = this.filterUniqueRows(fallback, input.columnNames, seen);
      generated.push(...uniqueFallback.slice(0, requestCount));

      if (uniqueFallback.length === 0 && requestCount > 0) {
        const forced = this.bootstrapRows(
          input.minorityExamples,
          input.columnNames,
          input.targetColumn,
          input.minorityLabel,
          requestCount,
          {
            startOffset: startOffset + generated.length + chunkIndex * 17 + 1,
            diversitySeed: `${diversitySeed}:forced:${chunkIndex}:${generated.length}`,
            seen,
            forceVariation: true,
          },
        );
        generated.push(...forced.slice(0, requestCount));
      }
    }

    return generated.slice(0, input.targetCount).map((row) => ({
      ...row,
      [input.targetColumn]: input.minorityLabel,
    }));
  }

  private async requestLlmRows(input: {
    columnNames: string[];
    targetColumn: string;
    minorityLabel: string;
    minorityExamples: Record<string, string>[];
    requestCount: number;
    analysis: DataSourceAnalysisResult | null;
    synthesisOptions: SynthesisOptions;
    constraintsText: string;
    context?: Record<string, unknown> | null;
    batchIndex?: number;
    totalBatches?: number;
    generatedSoFar?: number;
    priorSyntheticRows?: Record<string, string>[];
    diversitySeed?: string;
  }): Promise<Record<string, string>[]> {
    const batchIndex = input.batchIndex ?? 1;
    const totalBatches = input.totalBatches ?? 1;
    const priorRows = (input.priorSyntheticRows ?? []).slice(-12);

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_synthesis_rows',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          generation_notes: { type: 'string' },
        },
        required: ['rows', 'generation_notes'],
      },
      systemPrompt: [
        'You generate realistic synthetic tabular rows for minority-class augmentation.',
        'Return JSON only.',
        'Each row must use the exact column names provided.',
        'Respect clinical/domain plausibility and the listed constraints.',
        'Every row in the response must be mutually distinct.',
        'Do not copy example rows verbatim; create new plausible variations.',
      ].join(' '),
      userPrompt: [
        `Generate ${input.requestCount} unique synthetic rows.`,
        `Batch ${batchIndex}/${totalBatches} (already generated ${input.generatedSoFar ?? 0} rows in prior batches).`,
        `Diversity seed: ${input.diversitySeed ?? 'n/a'}`,
        `Columns: ${input.columnNames.join(', ')}`,
        `Target column: ${input.targetColumn} = ${input.minorityLabel}`,
        `Mode: ${input.synthesisOptions.mode ?? 'domain_guided'}`,
        `Constraints: ${input.constraintsText}`,
        `Industry: ${input.analysis?.domainForm?.industry ?? ''}`,
        `ML task: ${input.analysis?.domainForm?.ml_task ?? ''}`,
        `Target event: ${input.analysis?.domainForm?.target_event ?? ''}`,
        `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
        'Prior step context:',
        this.buildPriorContextDigest(input.context ?? null),
        `Matching review: ${JSON.stringify(input.context?.matchingReview ?? {})}`,
        priorRows.length
          ? 'Already generated rows in this run (do NOT duplicate — vary feature values and combinations):'
          : 'No prior synthetic rows in this run yet.',
        priorRows.length ? JSON.stringify(priorRows, null, 2) : '',
        'Minority examples (use as style reference, not for copy-paste):',
        JSON.stringify(input.minorityExamples.slice(0, 8), null, 2),
      ].filter(Boolean).join('\n'),
    });

    const payload = JSON.parse(raw) as { rows?: Array<Record<string, unknown>> };
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return rows
      .map((row) => this.normalizeGeneratedRow(row, input.columnNames, input.targetColumn, input.minorityLabel))
      .filter((row) => Object.keys(row).length > 0);
  }

  private normalizeGeneratedRow(
    row: Record<string, unknown>,
    columnNames: string[],
    targetColumn: string,
    minorityLabel: string,
  ): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const column of columnNames) {
      if (column === 'is_synthetic') continue;
      const value = row[column];
      normalized[column] = value === undefined || value === null ? '' : String(value);
    }
    normalized[targetColumn] = minorityLabel;
    return normalized;
  }

  private bootstrapRows(
    examples: Record<string, string>[],
    columnNames: string[],
    targetColumn: string,
    minorityLabel: string,
    count: number,
    options?: {
      startOffset?: number;
      diversitySeed?: string;
      seen?: Set<string>;
      forceVariation?: boolean;
    },
  ): Record<string, string>[] {
    const startOffset = options?.startOffset ?? 0;
    const seed = options?.diversitySeed ?? 'bootstrap';
    const forceVariation = options?.forceVariation ?? false;

    if (!examples.length) {
      const rows: Record<string, string>[] = [];
      for (let index = 0; index < count; index += 1) {
        const blank: Record<string, string> = {};
        const rand = seededUnitRandom(seed, startOffset + index);
        for (const column of columnNames) {
          if (column === targetColumn) {
            blank[column] = minorityLabel;
            continue;
          }
          blank[column] = forceVariation ? `syn_${startOffset + index}_${column}_${Math.floor(rand * 1000)}` : '';
        }
        rows.push(blank);
      }
      return rows;
    }

    const rows: Record<string, string>[] = [];
    for (let index = 0; index < count; index += 1) {
      const globalIndex = startOffset + index;
      const randA = seededUnitRandom(seed, globalIndex);
      const randB = seededUnitRandom(seed, globalIndex + 997);
      const source = examples[Math.floor(randA * examples.length) % examples.length];
      const altSource = examples[(Math.floor(randB * examples.length) + globalIndex + 1) % examples.length];
      const useAlt = examples.length > 1 && randB > 0.62;
      const next: Record<string, string> = {};

      for (const column of columnNames) {
        if (column === targetColumn) {
          next[column] = minorityLabel;
          continue;
        }
        const columnRand = seededUnitRandom(seed, globalIndex * 131 + column.length);
        const pickedSource = forceVariation
          ? examples[Math.floor(columnRand * examples.length) % examples.length]
          : (useAlt ? altSource : source);
        const base = String(pickedSource[column] ?? '');
        if (base && /^-?\d+(\.\d+)?$/.test(base)) {
          const numeric = Number(base);
          const jitterFactor = 0.9 + columnRand * 0.2 + (globalIndex % 7) * 0.01;
          const jittered = numeric * jitterFactor;
          next[column] = jittered.toFixed(4).replace(/\.?0+$/, '');
        } else {
          next[column] = base;
        }
      }
      rows.push(next);
    }
    return rows;
  }

  private describeRatio(
    rows: Record<string, string>[],
    targetColumn: string,
    minorityLabel: string,
  ): string {
    const dist = this.countDistribution(rows, targetColumn);
    const total = rows.length || 1;
    const minority = dist[minorityLabel] ?? 0;
    const majority = total - minority;
    return `${minorityLabel} ${minority} / 기타 ${majority} (총 ${total}행)`;
  }
}
