import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { extractJsonBlock } from '../modules/collection/collection-llm.utils';
import { StoreService } from '../store/store.service';
import { PipelineSynthesisService } from './pipeline-synthesis.service';

export type ResultsSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type ResultsComparisonMetric = {
  column: string;
  kind: 'numeric' | 'categorical';
  originalSummary: string;
  syntheticSummary: string;
  similarityScore: number | null;
  verdict: '유사' | '부분 유사' | '차이 큼';
};

export type PipelineStepResultsVisuals = {
  hasSynthesisArtifact: boolean;
  sourceFileName: string;
  originalRowCount: number;
  syntheticRowCount: number;
  targetColumn: string | null;
  minorityLabel: string | null;
  distributionBefore: string;
  distributionAfter: string;
  overallSimilarityScore: number;
  overallVerdict: '우수' | '양호' | '주의' | '부족';
  missingRateOriginalPercent: number;
  missingRateSyntheticPercent: number;
  duplicateLikeRowCount: number;
  comparisonMetrics: ResultsComparisonMetric[];
  staticSummary: string;
  llmInterpretation: string | null;
  recommendation: string;
};

export type ResultsExecutionResult = {
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  subTaskResults: ResultsSubTaskResult[];
  resultsVisuals: PipelineStepResultsVisuals;
};

const RESULTS_ADDON_CATALOG: Record<string, { label: string; description: string }> = {
  addon_res_distribution_compare: {
    label: '합성 전후 분포 비교',
    description: '타깃·주요 컬럼의 클래스/값 분포가 합성 전후 어떻게 변했는지 비교합니다.',
  },
  addon_res_numeric_similarity: {
    label: '수치형 프로필 유사도',
    description: '원본 소수 클래스와 합성 행의 평균·표준편차·범위를 비교해 유사도를 계산합니다.',
  },
  addon_res_categorical_alignment: {
    label: '범주형 분포 정렬도',
    description: '범주형 컬럼 상위 값 비율이 원본과 얼마나 맞는지 정적 비교합니다.',
  },
  addon_res_synthetic_quality_check: {
    label: '합성데이터 품질 검증',
    description: '결측률, 중복 유사 행, 비현실적 조합 여부를 코드 기반으로 점검합니다.',
  },
  addon_res_false_negative_analysis: {
    label: '데이터 보완 효과 요약',
    description: '합성 전후 소수 클래스 표본 수와 분포 변화를 요약합니다.',
  },
  addon_res_explainable_report: {
    label: '정적 비교 해석 리포트',
    description: 'LLM이 정적 분석 수치를 바탕으로 의사결정용 해석을 생성합니다.',
  },
};

const DEFAULT_RESULTS_ADDON_IDS = [
  'addon_res_distribution_compare',
  'addon_res_numeric_similarity',
  'addon_res_categorical_alignment',
  'addon_res_synthetic_quality_check',
];

type ParsedDataset = {
  columnNames: string[];
  rows: Record<string, string>[];
  fileName: string;
};

type ColumnProfile = {
  column: string;
  kind: 'numeric' | 'categorical';
  numeric?: { mean: number; std: number; min: number; max: number; count: number };
  categorical?: { top: Array<{ value: string; ratio: number }>; count: number };
  missingRate: number;
};

@Injectable()
export class PipelineResultsExecutionService {
  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
    private readonly synthesisService: PipelineSynthesisService,
  ) {}

  async execute(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string | null,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<ResultsExecutionResult> {
    if (!dataSourceId?.trim()) {
      throw new BadRequestException('결과 비교를 위해 연결된 데이터 소스가 필요합니다.');
    }

    const selectedAddonIds = this.resolveSelectedAddonIds(context);
    const original = await this.loadOriginalDataset(dataSourceId.trim());
    const synthesisContext = this.readSynthesisContext(context);
    const resolvedArtifact = await this.synthesisService.resolveArtifactForPipeline(
      pipelineId,
      actorUserId,
      synthesisContext.artifactId,
    );
    const augmented = await this.loadAugmentedDataset(resolvedArtifact, original);

    const targetColumn = resolvedArtifact?.targetColumn
      || synthesisContext.targetColumn
      || (synthesisContext.synthesisVisuals?.targetColumn as string | undefined)
      || this.resolveTargetColumn(original.columnNames, analysis, synthesisContext);
    const minorityLabel = resolvedArtifact?.minorityLabel
      || synthesisContext.minorityLabel
      || (synthesisContext.synthesisVisuals?.minorityLabel as string | undefined)
      || this.resolveMinorityLabel(analysis, original.rows, targetColumn);

    const originalRows = augmented?.originalRows?.length
      ? augmented.originalRows
      : original.rows;
    const syntheticRows = augmented?.syntheticRows ?? [];
    const hasSynthesis = syntheticRows.length > 0;

    const originalFocus = hasSynthesis && minorityLabel
      ? originalRows.filter((row) => String(row[targetColumn] ?? '').trim() === minorityLabel)
      : originalRows;
    const compareOriginal = originalFocus.length ? originalFocus : originalRows;

    const distributionBefore = this.describeDistribution(originalRows, targetColumn);
    const distributionAfter = hasSynthesis
      ? this.describeDistribution([...originalRows, ...syntheticRows], targetColumn)
      : distributionBefore;

    const comparisonMetrics = hasSynthesis
      ? this.buildComparisonMetrics(
        original.columnNames,
        compareOriginal,
        syntheticRows,
        targetColumn,
      )
      : [];

    const overallSimilarityScore = hasSynthesis
      ? this.averageSimilarity(comparisonMetrics)
      : 0;
    const overallVerdict = this.verdictFromScore(overallSimilarityScore, hasSynthesis);
    const missingRateOriginalPercent = this.averageMissingRate(compareOriginal, original.columnNames);
    const missingRateSyntheticPercent = hasSynthesis
      ? this.averageMissingRate(syntheticRows, original.columnNames)
      : missingRateOriginalPercent;
    const duplicateLikeRowCount = hasSynthesis
      ? this.countNearDuplicateRows(compareOriginal, syntheticRows, original.columnNames, targetColumn)
      : 0;

    const staticSummary = this.buildStaticSummary({
      hasSynthesis,
      overallSimilarityScore,
      overallVerdict,
      comparisonMetrics,
      missingRateOriginalPercent,
      missingRateSyntheticPercent,
      duplicateLikeRowCount,
      syntheticRowCount: syntheticRows.length,
    });

    let llmInterpretation: string | null = null;
    let llmUsed = false;
    if (this.llmClient.isConfigured()) {
      try {
        llmInterpretation = await this.requestLlmInterpretation({
          analysis,
          context,
          staticSummary,
          comparisonMetrics,
          distributionBefore,
          distributionAfter,
          overallSimilarityScore,
          overallVerdict,
          hasSynthesis,
        });
        llmUsed = Boolean(llmInterpretation);
      } catch {
        llmInterpretation = null;
      }
    }

    const recommendation = llmInterpretation
      ? this.extractRecommendation(llmInterpretation)
      : this.defaultRecommendation(overallVerdict, hasSynthesis);

    const resultsVisuals: PipelineStepResultsVisuals = {
      hasSynthesisArtifact: hasSynthesis,
      sourceFileName: augmented?.fileName ?? original.fileName,
      originalRowCount: originalRows.length,
      syntheticRowCount: syntheticRows.length,
      targetColumn,
      minorityLabel,
      distributionBefore,
      distributionAfter,
      overallSimilarityScore,
      overallVerdict,
      missingRateOriginalPercent,
      missingRateSyntheticPercent,
      duplicateLikeRowCount,
      comparisonMetrics: comparisonMetrics.slice(0, 12),
      staticSummary,
      llmInterpretation,
      recommendation,
    };

    const codeSubTasks = this.runCodeBasedSubTasks(
      selectedAddonIds,
      resultsVisuals,
      comparisonMetrics,
    );
    let subTaskResults = codeSubTasks;
    if (llmUsed) {
      try {
        subTaskResults = this.mergeSubTaskResults(
          codeSubTasks,
          await this.requestLlmSubTasks(selectedAddonIds, resultsVisuals, analysis, context),
        );
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    return {
      summary: hasSynthesis
        ? `정적 비교 완료: 유사도 ${overallSimilarityScore}% (${overallVerdict})`
        : '합성 결과 없음: 원본 데이터 기준 정적 프로필만 분석했습니다.',
      inputSummary: `${original.fileName} · 원본 ${originalRows.length}행`
        + (hasSynthesis ? ` · 합성 ${syntheticRows.length}행` : ''),
      evidence: [
        resolvedArtifact
          ? `합성 artifact: ${resolvedArtifact.artifactId} (${resolvedArtifact.syntheticRowCount}행)`
          : '합성 artifact 미연결',
        `타깃 컬럼: ${targetColumn}`,
        hasSynthesis ? `합성 전 분포: ${distributionBefore}` : `현재 분포: ${distributionBefore}`,
        hasSynthesis ? `합성 후 분포: ${distributionAfter}` : '',
        hasSynthesis ? `종합 유사도: ${overallSimilarityScore}% (${overallVerdict})` : '합성 artifact 없음',
        `결측률 원본 ${missingRateOriginalPercent.toFixed(1)}%`
          + (hasSynthesis ? ` / 합성 ${missingRateSyntheticPercent.toFixed(1)}%` : ''),
        duplicateLikeRowCount > 0 ? `유사 중복 의심 행: ${duplicateLikeRowCount}건` : '',
        ...subTaskResults.slice(0, 3).map((item) => `[${item.label}] ${item.summary}`),
        analysis?.diagnosisSummary ? `진단: ${analysis.diagnosisSummary}` : '',
      ].filter(Boolean),
      expectedResult: recommendation,
      llmUsed,
      subTaskResults,
      resultsVisuals,
    };
  }

  private resolveSelectedAddonIds(context: Record<string, unknown> | null | undefined): string[] {
    const raw = context?.selectedAddonIds;
    const ids = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter((id) => RESULTS_ADDON_CATALOG[id])
      : [];
    if (ids.length > 0) return ids;
    return DEFAULT_RESULTS_ADDON_IDS;
  }

  private readSynthesisContext(context: Record<string, unknown> | null | undefined) {
    const artifact = context?.synthesisArtifact as Record<string, unknown> | null | undefined;
    const visuals = context?.synthesisVisuals as Record<string, unknown> | null | undefined;
    const artifactId = typeof artifact?.artifactId === 'string'
      ? artifact.artifactId
      : typeof context?.synthesisArtifactId === 'string'
        ? context.synthesisArtifactId
        : null;
    return {
      artifactId,
      targetColumn: typeof artifact?.targetColumn === 'string'
        ? artifact.targetColumn
        : typeof visuals?.targetColumn === 'string'
          ? visuals.targetColumn
          : null,
      minorityLabel: typeof artifact?.minorityLabel === 'string'
        ? artifact.minorityLabel
        : typeof visuals?.minorityLabel === 'string'
          ? visuals.minorityLabel
          : null,
      synthesisVisuals: visuals,
    };
  }

  private async loadOriginalDataset(dataSourceId: string): Promise<ParsedDataset> {
    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('원본 CSV 파일이 없습니다.');
    }
    const parsed = Papa.parse<Record<string, string>>(sample.content.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    const rows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    if (!rows.length) {
      throw new BadRequestException('원본 CSV에 데이터 행이 없습니다.');
    }
    return {
      columnNames: parsed.meta.fields?.filter(Boolean) ?? Object.keys(rows[0] ?? {}),
      rows,
      fileName: sample.fileName,
    };
  }

  private async loadAugmentedDataset(
    artifact: import('./pipeline-synthesis.service').SynthesisArtifactMeta | null,
    original: ParsedDataset,
  ): Promise<{
    originalRows: Record<string, string>[];
    syntheticRows: Record<string, string>[];
    fileName: string;
  } | null> {
    if (!artifact?.artifactId) return null;
    try {
      const content = (await this.synthesisService.readArtifactContent(artifact)).toString('utf8');
      const parsed = Papa.parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
      });
      const rows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
      const hasFlag = rows.some((row) => row.is_synthetic !== undefined);
      if (hasFlag) {
        const syntheticRows = rows.filter((row) => String(row.is_synthetic ?? '0') === '1');
        if (!syntheticRows.length) return null;
        return {
          originalRows: rows.filter((row) => String(row.is_synthetic ?? '0') !== '1'),
          syntheticRows,
          fileName: artifact.fileName,
        };
      }
      const syntheticCount = artifact.syntheticRowCount ?? 0;
      if (syntheticCount > 0 && rows.length > original.rows.length) {
        return {
          originalRows: rows.slice(0, rows.length - syntheticCount),
          syntheticRows: rows.slice(rows.length - syntheticCount),
          fileName: artifact.fileName,
        };
      }
      if (syntheticCount > 0 && rows.length >= syntheticCount) {
        return {
          originalRows: rows.slice(0, Math.max(0, rows.length - syntheticCount)),
          syntheticRows: rows.slice(Math.max(0, rows.length - syntheticCount)),
          fileName: artifact.fileName,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveTargetColumn(
    columnNames: string[],
    analysis: DataSourceAnalysisResult | null,
    synthesisContext: ReturnType<PipelineResultsExecutionService['readSynthesisContext']>,
  ): string {
    if (synthesisContext.targetColumn && columnNames.includes(synthesisContext.targetColumn)) {
      return synthesisContext.targetColumn;
    }
    const explicit = analysis?.targetColumn?.trim();
    if (explicit && columnNames.includes(explicit)) return explicit;
    const targetEvent = analysis?.domainForm?.target_event?.trim() ?? '';
    const eqMatch = targetEvent.match(/^([A-Za-z0-9_]+)\s*=/);
    if (eqMatch?.[1] && columnNames.includes(eqMatch[1])) return eqMatch[1];
    const heuristic = columnNames.find((column) => /label|target|class|result|outcome|flag/i.test(column));
    return heuristic ?? columnNames[columnNames.length - 1];
  }

  private resolveMinorityLabel(
    analysis: DataSourceAnalysisResult | null,
    rows: Record<string, string>[],
    targetColumn: string,
  ): string | null {
    const explicit = analysis?.targetLabel?.trim();
    const distribution = this.countDistribution(rows, targetColumn);
    if (explicit && distribution[explicit] !== undefined) return explicit;
    const sorted = Object.entries(distribution).sort((a, b) => a[1] - b[1]);
    return sorted[0]?.[0] ?? null;
  }

  private countDistribution(rows: Record<string, string>[], targetColumn: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = String(row[targetColumn] ?? 'UNKNOWN').trim() || 'UNKNOWN';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private describeDistribution(rows: Record<string, string>[], targetColumn: string): string {
    const dist = this.countDistribution(rows, targetColumn);
    const total = rows.length || 1;
    return Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => `${label} ${count} (${((count / total) * 100).toFixed(1)}%)`)
      .join(', ');
  }

  private buildComparisonMetrics(
    columnNames: string[],
    originalRows: Record<string, string>[],
    syntheticRows: Record<string, string>[],
    targetColumn: string,
  ): ResultsComparisonMetric[] {
    const metrics: ResultsComparisonMetric[] = [];
    const candidates = columnNames.filter((column) => column !== 'is_synthetic').slice(0, 20);

    for (const column of candidates) {
      const originalProfile = this.profileColumn(column, originalRows);
      const syntheticProfile = this.profileColumn(column, syntheticRows);
      if (!originalProfile || !syntheticProfile) continue;

      if (originalProfile.kind === 'numeric' && originalProfile.numeric && syntheticProfile.numeric) {
        const score = this.numericSimilarity(originalProfile.numeric, syntheticProfile.numeric);
        metrics.push({
          column,
          kind: 'numeric',
          originalSummary: `μ=${originalProfile.numeric.mean.toFixed(2)}, σ=${originalProfile.numeric.std.toFixed(2)}, range=[${originalProfile.numeric.min}, ${originalProfile.numeric.max}]`,
          syntheticSummary: `μ=${syntheticProfile.numeric.mean.toFixed(2)}, σ=${syntheticProfile.numeric.std.toFixed(2)}, range=[${syntheticProfile.numeric.min}, ${syntheticProfile.numeric.max}]`,
          similarityScore: score,
          verdict: this.metricVerdict(score),
        });
        continue;
      }

      if (originalProfile.kind === 'categorical' && originalProfile.categorical && syntheticProfile.categorical) {
        const score = this.categoricalSimilarity(originalProfile.categorical, syntheticProfile.categorical);
        const fmt = (profile: ColumnProfile) => profile.categorical?.top
          .slice(0, 3)
          .map((item) => `${item.value} ${(item.ratio * 100).toFixed(0)}%`)
          .join(', ') ?? '-';
        metrics.push({
          column,
          kind: 'categorical',
          originalSummary: fmt(originalProfile),
          syntheticSummary: fmt(syntheticProfile),
          similarityScore: score,
          verdict: this.metricVerdict(score),
        });
      }
    }

    const targetFirst = metrics.sort((a, b) => {
      if (a.column === targetColumn) return -1;
      if (b.column === targetColumn) return 1;
      return (b.similarityScore ?? 0) - (a.similarityScore ?? 0);
    });
    return targetFirst;
  }

  private profileColumn(column: string, rows: Record<string, string>[]): ColumnProfile | null {
    if (!rows.length) return null;
    const values = rows.map((row) => String(row[column] ?? '').trim());
    const nonMissing = values.filter((value) => value !== '' && value.toLowerCase() !== 'null');
    const missingRate = ((values.length - nonMissing.length) / values.length) * 100;
    const numericValues = nonMissing
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (numericValues.length >= Math.max(3, Math.floor(nonMissing.length * 0.6))) {
      const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
      const variance = numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numericValues.length;
      return {
        column,
        kind: 'numeric',
        missingRate,
        numeric: {
          mean,
          std: Math.sqrt(variance),
          min: Math.min(...numericValues),
          max: Math.max(...numericValues),
          count: numericValues.length,
        },
      };
    }
    const counts: Record<string, number> = {};
    for (const value of nonMissing) counts[value] = (counts[value] ?? 0) + 1;
    const total = nonMissing.length || 1;
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, ratio: count / total }));
    return { column, kind: 'categorical', missingRate, categorical: { top, count: nonMissing.length } };
  }

  private numericSimilarity(
    original: NonNullable<ColumnProfile['numeric']>,
    synthetic: NonNullable<ColumnProfile['numeric']>,
  ): number {
    const meanGap = Math.abs(original.mean - synthetic.mean);
    const scale = Math.max(Math.abs(original.mean), original.std, 1);
    const meanScore = Math.max(0, 1 - meanGap / scale);
    const stdGap = Math.abs(original.std - synthetic.std);
    const stdScore = Math.max(0, 1 - stdGap / Math.max(original.std, 1));
    const rangeOrig = Math.max(original.max - original.min, 1e-6);
    const rangeOverlap = Math.max(
      0,
      Math.min(original.max, synthetic.max) - Math.max(original.min, synthetic.min),
    ) / rangeOrig;
    return Math.round((meanScore * 0.5 + stdScore * 0.25 + rangeOverlap * 0.25) * 100);
  }

  private categoricalSimilarity(
    original: NonNullable<ColumnProfile['categorical']>,
    synthetic: NonNullable<ColumnProfile['categorical']>,
  ): number {
    const keys = new Set([
      ...original.top.map((item) => item.value),
      ...synthetic.top.map((item) => item.value),
    ]);
    let distance = 0;
    for (const key of keys) {
      const left = original.top.find((item) => item.value === key)?.ratio ?? 0;
      const right = synthetic.top.find((item) => item.value === key)?.ratio ?? 0;
      distance += Math.abs(left - right);
    }
    return Math.round(Math.max(0, 1 - distance / 2) * 100);
  }

  private metricVerdict(score: number): ResultsComparisonMetric['verdict'] {
    if (score >= 75) return '유사';
    if (score >= 50) return '부분 유사';
    return '차이 큼';
  }

  private averageSimilarity(metrics: ResultsComparisonMetric[]): number {
    const scores = metrics.map((item) => item.similarityScore).filter((score): score is number => score != null);
    if (!scores.length) return 0;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  }

  private verdictFromScore(score: number, hasSynthesis: boolean): PipelineStepResultsVisuals['overallVerdict'] {
    if (!hasSynthesis) return '부족';
    if (score >= 80) return '우수';
    if (score >= 65) return '양호';
    if (score >= 45) return '주의';
    return '부족';
  }

  private averageMissingRate(rows: Record<string, string>[], columnNames: string[]): number {
    if (!rows.length || !columnNames.length) return 0;
    let totalCells = 0;
    let missingCells = 0;
    for (const row of rows) {
      for (const column of columnNames) {
        if (column === 'is_synthetic') continue;
        totalCells += 1;
        const value = String(row[column] ?? '').trim();
        if (!value || value.toLowerCase() === 'null') missingCells += 1;
      }
    }
    return totalCells > 0 ? (missingCells / totalCells) * 100 : 0;
  }

  private countNearDuplicateRows(
    originalRows: Record<string, string>[],
    syntheticRows: Record<string, string>[],
    columnNames: string[],
    targetColumn: string,
  ): number {
    const compareColumns = columnNames.filter((column) => !['is_synthetic', targetColumn].includes(column)).slice(0, 8);
    if (!compareColumns.length) return 0;
    const signatures = new Set(
      originalRows.slice(0, 500).map((row) => compareColumns.map((column) => row[column] ?? '').join('|')),
    );
    let duplicates = 0;
    for (const row of syntheticRows) {
      const signature = compareColumns.map((column) => row[column] ?? '').join('|');
      if (signatures.has(signature)) duplicates += 1;
    }
    return duplicates;
  }

  private buildStaticSummary(input: {
    hasSynthesis: boolean;
    overallSimilarityScore: number;
    overallVerdict: PipelineStepResultsVisuals['overallVerdict'];
    comparisonMetrics: ResultsComparisonMetric[];
    missingRateOriginalPercent: number;
    missingRateSyntheticPercent: number;
    duplicateLikeRowCount: number;
    syntheticRowCount: number;
  }): string {
    if (!input.hasSynthesis) {
      return '합성 artifact가 없어 원본 데이터 프로필만 분석했습니다. 합성 단계를 먼저 실행하세요.';
    }
    const weakColumns = input.comparisonMetrics
      .filter((item) => (item.similarityScore ?? 0) < 50)
      .slice(0, 3)
      .map((item) => item.column);
    const parts = [
      `정적 유사도 ${input.overallSimilarityScore}% (${input.overallVerdict})`,
      `합성 ${input.syntheticRowCount}행 검증`,
      `결측률 ${input.missingRateOriginalPercent.toFixed(1)}% → ${input.missingRateSyntheticPercent.toFixed(1)}%`,
    ];
    if (input.duplicateLikeRowCount > 0) {
      parts.push(`원본과 동일 패턴 의심 ${input.duplicateLikeRowCount}행`);
    }
    if (weakColumns.length) {
      parts.push(`차이 큰 컬럼: ${weakColumns.join(', ')}`);
    }
    return parts.join(' · ');
  }

  private defaultRecommendation(
    verdict: PipelineStepResultsVisuals['overallVerdict'],
    hasSynthesis: boolean,
  ): string {
    if (!hasSynthesis) return '합성 단계 실행 후 다시 결과 비교를 수행하세요.';
    if (verdict === '우수' || verdict === '양호') return '합성 데이터를 학습/검증에 사용해도 무방합니다.';
    if (verdict === '주의') return '차이가 큰 컬럼을 확인하고 합성 설정을 조정한 뒤 재생성하세요.';
    return '합성 품질이 낮습니다. 생성 행 수·제약 조건을 재검토하세요.';
  }

  private extractRecommendation(text: string): string {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const recommendationLine = lines.find((line) => /권장|결론|추천/.test(line));
    return recommendationLine ?? lines[lines.length - 1] ?? text.slice(0, 240);
  }

  private runCodeBasedSubTasks(
    addonIds: string[],
    visuals: PipelineStepResultsVisuals,
    metrics: ResultsComparisonMetric[],
  ): ResultsSubTaskResult[] {
    return addonIds.map((id) => {
      const meta = RESULTS_ADDON_CATALOG[id];
      if (id === 'addon_res_distribution_compare') {
        return {
          id,
          label: meta?.label ?? id,
          status: 'done',
          summary: `합성 전후 타깃 분포 비교 (${visuals.targetColumn ?? 'target'})`,
          findings: [
            `합성 전: ${visuals.distributionBefore}`,
            `합성 후: ${visuals.distributionAfter}`,
            visuals.minorityLabel ? `소수 라벨: ${visuals.minorityLabel}` : '',
          ].filter(Boolean),
        };
      }
      if (id === 'addon_res_numeric_similarity') {
        const numeric = metrics.filter((item) => item.kind === 'numeric').slice(0, 4);
        return {
          id,
          label: meta?.label ?? id,
          status: 'done',
          summary: numeric.length
            ? `수치형 ${numeric.length}개 컬럼 평균 유사도 ${Math.round(numeric.reduce((sum, item) => sum + (item.similarityScore ?? 0), 0) / numeric.length)}%`
            : '수치형 컬럼 프로필 비교',
          findings: numeric.map((item) => `${item.column}: ${item.similarityScore}% (${item.verdict})`),
        };
      }
      if (id === 'addon_res_categorical_alignment') {
        const categorical = metrics.filter((item) => item.kind === 'categorical').slice(0, 4);
        return {
          id,
          label: meta?.label ?? id,
          status: 'done',
          summary: categorical.length
            ? `범주형 ${categorical.length}개 컬럼 분포 정렬도 분석`
            : '범주형 컬럼 분포 비교',
          findings: categorical.map((item) => `${item.column}: ${item.similarityScore}% (${item.verdict})`),
        };
      }
      if (id === 'addon_res_synthetic_quality_check') {
        return {
          id,
          label: meta?.label ?? id,
          status: 'done',
          summary: `품질 점검: 결측·중복·유사도 종합 ${visuals.overallVerdict}`,
          findings: [
            `종합 유사도 ${visuals.overallSimilarityScore}%`,
            `결측률 ${visuals.missingRateOriginalPercent.toFixed(1)}% → ${visuals.missingRateSyntheticPercent.toFixed(1)}%`,
            visuals.duplicateLikeRowCount > 0
              ? `중복 유사 행 ${visuals.duplicateLikeRowCount}건`
              : '중복 유사 행 없음',
          ],
        };
      }
      if (id === 'addon_res_false_negative_analysis') {
        return {
          id,
          label: meta?.label ?? '데이터 보완 효과 요약',
          status: 'done',
          summary: visuals.hasSynthesisArtifact
            ? `소수 표본 ${visuals.originalRowCount}행 → 합성 후 +${visuals.syntheticRowCount}행`
            : '합성 데이터 없음',
          findings: [visuals.distributionBefore, visuals.distributionAfter],
        };
      }
      return {
        id,
        label: meta?.label ?? id,
        status: 'done',
        summary: visuals.staticSummary,
        findings: [],
      };
    });
  }

  private async requestLlmInterpretation(input: {
    analysis: DataSourceAnalysisResult | null;
    context: Record<string, unknown> | null;
    staticSummary: string;
    comparisonMetrics: ResultsComparisonMetric[];
    distributionBefore: string;
    distributionAfter: string;
    overallSimilarityScore: number;
    overallVerdict: string;
    hasSynthesis: boolean;
  }): Promise<string> {
    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_results_interpretation',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interpretation: { type: 'string' },
          recommendation: { type: 'string' },
          risk_notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['interpretation', 'recommendation', 'risk_notes'],
      },
      systemPrompt: [
        'You interpret static comparison results between original and synthetic tabular medical data.',
        'Do not invent AUROC/AUPRC or model metrics unless explicitly provided.',
        'Focus on distribution similarity, column profiles, missingness, and fidelity.',
        'Respond in Korean.',
      ].join(' '),
      userPrompt: [
        `Has synthesis artifact: ${input.hasSynthesis}`,
        `Overall similarity: ${input.overallSimilarityScore}% (${input.overallVerdict})`,
        `Distribution before: ${input.distributionBefore}`,
        `Distribution after: ${input.distributionAfter}`,
        `Static summary: ${input.staticSummary}`,
        'Column metrics:',
        JSON.stringify(input.comparisonMetrics.slice(0, 10), null, 2),
        `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
        `Domain: ${JSON.stringify(input.analysis?.domainForm ?? {})}`,
        `Synthesis visuals: ${JSON.stringify(input.context?.synthesisVisuals ?? {})}`,
      ].join('\n'),
    });
    const payload = this.parseLlmJson<{
      interpretation?: string;
      recommendation?: string;
      risk_notes?: string[];
    }>(raw);
    if (!payload) {
      throw new Error('LLM interpretation JSON parse failed');
    }
    const risks = Array.isArray(payload.risk_notes) ? payload.risk_notes.filter(Boolean) : [];
    return [
      String(payload.interpretation ?? '').trim(),
      risks.length ? `주의: ${risks.join('; ')}` : '',
      `권장: ${String(payload.recommendation ?? '').trim()}`,
    ].filter(Boolean).join('\n');
  }

  private async requestLlmSubTasks(
    addonIds: string[],
    visuals: PipelineStepResultsVisuals,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<ResultsSubTaskResult[]> {
    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_results_subtasks',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
        required: ['sub_tasks'],
      },
      systemPrompt: 'Summarize static data comparison sub-tasks for clinical ML. Korean only. No AUROC unless given.',
      userPrompt: [
        'Addons:',
        addonIds.map((id) => `- ${id}: ${RESULTS_ADDON_CATALOG[id]?.label ?? id}`).join('\n'),
        `Static summary: ${visuals.staticSummary}`,
        `Metrics: ${JSON.stringify(visuals.comparisonMetrics.slice(0, 8))}`,
        `Diagnosis: ${analysis?.diagnosisSummary ?? ''}`,
        `Context summary: ${this.summarizeResultsContext(context)}`,
      ].join('\n'),
    });
    const payload = this.parseLlmJson<{
      sub_tasks?: Array<{ addon_id?: string; summary?: string; findings?: string[]; status?: string }>;
    }>(raw);
    if (!payload?.sub_tasks?.length) {
      return [];
    }
    return (payload.sub_tasks ?? [])
      .filter((item) => item?.addon_id && RESULTS_ADDON_CATALOG[item.addon_id])
      .map((item) => ({
        id: String(item.addon_id),
        label: RESULTS_ADDON_CATALOG[String(item.addon_id)].label,
        status: item.status === 'failed' ? 'failed' as const : 'done' as const,
        summary: String(item.summary ?? '').trim() || '분석 완료',
        findings: Array.isArray(item.findings) ? item.findings.map(String).filter(Boolean) : [],
      }));
  }

  private mergeSubTaskResults(
    codeResults: ResultsSubTaskResult[],
    llmResults: ResultsSubTaskResult[],
  ): ResultsSubTaskResult[] {
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

  private parseLlmJson<T>(raw: string): T | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      const block = extractJsonBlock(trimmed);
      if (!block) return null;
      try {
        return JSON.parse(block) as T;
      } catch {
        return null;
      }
    }
  }

  private summarizeResultsContext(context: Record<string, unknown> | null): string {
    if (!context || typeof context !== 'object') return '(none)';
    const matchingReview = context.matchingReview as Record<string, unknown> | undefined;
    const synthesisVisuals = context.synthesisVisuals as Record<string, unknown> | undefined;
    const matchingVisuals = context.matchingVisuals as Record<string, unknown> | undefined;
    const approvedIds = Array.isArray(context.approvedCandidateIds)
      ? context.approvedCandidateIds.map(String)
      : [];
    return [
      matchingReview?.finalFit ? `matching_fit=${matchingReview.finalFit}` : '',
      matchingReview?.actionPlan ? `matching_action=${matchingReview.actionPlan}` : '',
      matchingVisuals?.candidateName ? `candidate=${matchingVisuals.candidateName}` : '',
      approvedIds.length ? `approved_candidates=${approvedIds.join(',')}` : '',
      synthesisVisuals?.recommendedRowCount != null
        ? `synthetic_rows=${synthesisVisuals.recommendedRowCount}`
        : '',
      synthesisVisuals?.distributionAfter ? `distribution_after=${synthesisVisuals.distributionAfter}` : '',
    ].filter(Boolean).join(' · ') || '(none)';
  }
}
