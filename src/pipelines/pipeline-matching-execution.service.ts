import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import type { PipelineStepDomainVisuals } from './pipeline-domain-execution.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { StoreService } from '../store/store.service';
import {
  PipelineDataMergeService,
  type MergeArtifactMeta,
  type MergeVisuals,
} from './pipeline-data-merge.service';

export type MatchingSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type MatchingComparisonRow = {
  item: string;
  current: string;
  candidate: string;
  result: '적합' | '부분 적합' | '부적합';
};

export type PipelineStepMatchingVisuals = {
  candidateId: string | null;
  candidateName: string;
  candidateSource: string;
  comparisonRows: MatchingComparisonRow[];
  finalFit: '적합' | '부분 적합' | '부적합';
  actionPlan: string;
  fitScorePercent: number;
  mergeGuidance?: {
    recommendation: string;
    mergeableAspects: string[];
    cautionAspects: string[];
    suggestedColumns: string[];
  };
};

export type MatchingReviewSnapshot = {
  finalFit: string;
  actionPlan: string;
};

export type MatchingExecutionResult = {
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  subTaskResults: MatchingSubTaskResult[];
  matchingVisuals: PipelineStepMatchingVisuals;
  matchingReview: MatchingReviewSnapshot;
  mergeArtifact?: MergeArtifactMeta | null;
  mergeVisuals?: MergeVisuals | null;
};

type CandidateDataset = {
  id: string;
  name: string;
  description: string;
  modality: string;
  rowsHint: string;
  score: number;
  matchedKeywords: string[];
  provider: string;
  resourcePlan?: {
    extractVariables?: string;
    extractLabel?: string;
    rowUnit?: string;
    usagePurpose?: string;
    notes?: string;
  };
};

type CandidateKnowledge = {
  id: string;
  title: string;
  plannedUsage?: string;
  plannedExtract?: string;
  plannedNotes?: string;
};

type CurrentDataSummary = {
  fileName: string;
  rowCount: number;
  columnCount: number;
  columns: string[];
  dataModality: string;
  rowUnit: string;
  targetColumn: string | null;
  targetLabel: string | null;
  mlTask: string;
  targetEvent: string;
  includeScope: string;
  excludeScope: string;
  observationWindow: string;
  labelRules: string[];
  columnMeanings: string[];
  sampleRows: Record<string, string>[];
};

const MATCHING_ADDON_CATALOG: Record<string, { label: string; description: string }> = {
  addon_match_clinical_semantics: {
    label: '임상 의미 정합성 검토',
    description: '같은 컬럼처럼 보여도 실제 임상 의미가 같은지 검토합니다.',
  },
  addon_match_label_consistency: {
    label: '라벨 기준 정합성 검토',
    description: '정상·이상 라벨 정의가 원본과 후보에서 일관되는지 확인합니다.',
  },
  addon_match_temporal_resolution: {
    label: '시계열 해상도 비교',
    description: '샘플링 주기, 관측 시간, 시간 단위가 호환되는지 검토합니다.',
  },
  addon_match_population_distribution: {
    label: '환자군 분포 비교',
    description: '연령, 성별, 질환군, 중증도 등 데이터 모집단 차이를 비교합니다.',
  },
  addon_match_physio_range: {
    label: '의료 변수 생리학적 범위 검증',
    description: '심박수, 혈압, 체온, 검사 수치 등이 의학적으로 가능한 범위인지 검토합니다.',
  },
};

const DEFAULT_MATCHING_ADDON_IDS = [
  'addon_match_clinical_semantics',
  'addon_match_label_consistency',
  'addon_match_temporal_resolution',
  'addon_match_population_distribution',
];

const TEXT_SYNONYM_GROUPS = [
  ['tabular', 'table', 'structured', '구조화', '정형'],
  ['time series', 'timeseries', 'temporal', '시계열', 'series'],
  ['patient', 'visit', 'encounter', '환자', '입원', '내원'],
  ['row', 'record', 'instance', '행', '레코드'],
  ['event', 'label', 'target', 'outcome', '이벤트', '라벨', '타깃'],
  ['adverse', 'safety', 'warning', '이상', '부작용', 'safty'],
];

const ROW_UNIT_SYNONYMS = [
  ['patient visit', 'visit', 'encounter', 'patient-visit', '환자 방문', '내원'],
  ['patient', 'subject', '환자', '피험자'],
  ['admission', '입원', 'hospitalization'],
];

@Injectable()
export class PipelineMatchingExecutionService {
  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
    private readonly mergeService: PipelineDataMergeService,
  ) {}

  async execute(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string | null,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<MatchingExecutionResult> {
    const domainForm = this.resolveDomainForm(analysis, context);
    const domainVisuals = this.resolveDomainVisuals(context);
    const candidate = this.resolveCandidate(context);
    const candidateKnowledge = this.resolveCandidateKnowledge(context);
    const current = await this.buildCurrentDataSummary(dataSourceId, analysis, domainForm, domainVisuals);

    if (!current.columns.length && !domainForm.industry && !domainForm.ml_task) {
      throw new BadRequestException('정합성 검토에 사용할 현재 데이터 또는 도메인 정의가 없습니다.');
    }

    const selectedAddonIds = this.resolveSelectedAddonIds(context);
    const comparisonRows = this.buildComparisonRows(current, candidate, domainVisuals);
    const codeSubTasks = this.runCodeBasedSubTasks(
      selectedAddonIds,
      current,
      candidate,
      comparisonRows,
      domainVisuals,
    );

    let llmUsed = false;
    let subTaskResults = codeSubTasks;
    let refinedRows = comparisonRows;
    let finalFit = this.deriveFinalFit(comparisonRows);
    let actionPlan = this.deriveActionPlan(finalFit);
    let summaryNote = '';

    if (this.llmClient.isConfigured()) {
      try {
        const llm = await this.requestLlmMatching({
          current,
          candidate,
          domainForm,
          domainVisuals,
          selectedAddonIds,
          comparisonRows,
          diagnosisSummary: analysis?.diagnosisSummary ?? String(context?.diagnosisSummary ?? ''),
          qualityCheck: context?.qualityCheck ?? null,
          priorEvidence: context?.priorEvidence ?? null,
          candidateKnowledge,
        });
        subTaskResults = this.mergeSubTaskResults(codeSubTasks, llm.subTaskResults);
        if (llm.comparisonRows.length) refinedRows = llm.comparisonRows;
        finalFit = llm.finalFit || finalFit;
        actionPlan = llm.actionPlan || actionPlan;
        summaryNote = llm.summaryNote;
        llmUsed = true;
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    const fitScorePercent = this.scoreFromRows(refinedRows);
    const mergeGuidance = this.buildMergeGuidance(refinedRows, candidate, current, finalFit);
    const matchingVisuals: PipelineStepMatchingVisuals = {
      candidateId: candidate.id,
      candidateName: candidate.name,
      candidateSource: candidate.provider,
      comparisonRows: refinedRows,
      finalFit,
      actionPlan,
      fitScorePercent,
      mergeGuidance,
    };

    let mergeArtifact: MergeArtifactMeta | null = null;
    let mergeVisuals: MergeVisuals | null = null;
    if (dataSourceId) {
      try {
        const mergeResult = await this.mergeService.mergeForMatching({
          actorUserId,
          pipelineId,
          dataSourceId,
          matchingVisuals,
          candidate,
        });
        mergeArtifact = mergeResult.artifact;
        mergeVisuals = mergeResult.visuals;
      } catch {
        mergeArtifact = null;
        mergeVisuals = null;
      }
    }

    const evidence = [
      `[현재] ${current.fileName} · ${current.rowCount}행 · ${current.columnCount}컬럼`,
      `[후보] ${candidate.name}${candidate.id ? ` (${candidate.provider})` : ''}`,
      candidate.resourcePlan?.usagePurpose ? `[후보 활용] ${candidate.resourcePlan.usagePurpose}` : '',
      candidate.resourcePlan?.extractVariables ? `[발췌 변수] ${candidate.resourcePlan.extractVariables}` : '',
      candidate.resourcePlan?.extractLabel ? `[발췌 라벨] ${candidate.resourcePlan.extractLabel}` : '',
      `[도메인] ${domainForm.industry || '미정'} · ${domainForm.ml_task || 'ML task 미정'}`,
      current.targetColumn ? `[타깃] ${current.targetColumn}${current.targetLabel ? `=${current.targetLabel}` : ''}` : '',
      `[적합도] ${finalFit} (${fitScorePercent}%) · ${actionPlan}`,
      mergeGuidance.recommendation ? `[병합] ${mergeGuidance.recommendation}` : '',
      ...candidateKnowledge.slice(0, 3).map((item) => `[지식] ${item.title}: ${item.plannedExtract || item.plannedUsage || '근거 미지정'}`),
      ...subTaskResults.slice(0, 4).map((item) => `[${item.label}] ${item.summary}`),
      mergeVisuals?.summary ? `[병합 결과] ${mergeVisuals.summary}` : '',
      ...(mergeVisuals?.addedColumns ?? []).map((column) => `[병합 컬럼] ${column}`),
    ].filter(Boolean);

    const expectedResult = mergeArtifact
      ? `병합 CSV 준비 완료 — 외부 변수 ${mergeVisuals?.addedColumns?.length ?? 0}개 추가, 합성 입력으로 사용 가능`
      : mergeVisuals?.status === 'reference_only'
        ? '참조·벤치마크만 활용 — 원본 데이터로 합성 진행'
        : finalFit === '적합'
          ? '후보 데이터를 정합성 검토 통과로 기록'
          : finalFit === '부분 적합'
            ? '부분 적용 범위를 확정하고 다음 단계 진행'
            : '후보 제외 또는 다른 후보 재탐색 권장';

    const summary = summaryNote || (llmUsed
      ? `정합성 검토 LLM 완료 — ${candidate.name} vs 현재 데이터 (${finalFit})`
      : `정합성 검토 완료 — ${candidate.name} vs 현재 데이터 (${finalFit})`);

    return {
      summary,
      inputSummary: `${current.fileName} vs ${candidate.name}`,
      evidence,
      expectedResult,
      llmUsed: llmUsed || Boolean(analysis?.llmUsed),
      subTaskResults,
      matchingVisuals,
      matchingReview: { finalFit, actionPlan },
      mergeArtifact,
      mergeVisuals,
    };
  }

  private resolveDomainForm(
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ) {
    const fromContext = (context?.domainForm && typeof context.domainForm === 'object')
      ? context.domainForm as Record<string, string>
      : {};
    const fromAnalysis: Partial<Record<string, string>> = analysis?.domainForm ?? {};
    return {
      industry: fromContext.industry || fromAnalysis.industry || '',
      subdomain: fromContext.subdomain || fromAnalysis.subdomain || '',
      data_modality: fromContext.data_modality || fromAnalysis.data_modality || analysis?.dataModality || '',
      row_unit: fromContext.row_unit || fromAnalysis.row_unit || analysis?.rowUnit || '',
      ml_task: fromContext.ml_task || fromAnalysis.ml_task || '',
      target_event: fromContext.target_event || fromAnalysis.target_event || '',
      include_scope: fromContext.include_scope || fromAnalysis.include_scope || '',
      exclude_scope: fromContext.exclude_scope || fromAnalysis.exclude_scope || '',
    };
  }

  private resolveDomainVisuals(context: Record<string, unknown> | null): PipelineStepDomainVisuals | null {
    const raw = context?.domainVisuals;
    return raw && typeof raw === 'object' ? raw as PipelineStepDomainVisuals : null;
  }

  private resolveSelectedAddonIds(context: Record<string, unknown> | null): string[] {
    const raw = context?.selectedAddonIds;
    const ids = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter((id) => MATCHING_ADDON_CATALOG[id])
      : [];
    return ids.length > 0 ? ids : DEFAULT_MATCHING_ADDON_IDS;
  }

  private resolveCandidateKnowledge(context: Record<string, unknown> | null): CandidateKnowledge[] {
    const raw = Array.isArray(context?.candidateKnowledge) ? context.candidateKnowledge : [];
    const results: CandidateKnowledge[] = [];

    raw.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? '').trim();
      const title = String(record.title ?? id).trim();
      if (!id && !title) return;

      const entry: CandidateKnowledge = {
        id: id || title,
        title,
      };
      const plannedUsage = String(record.plannedUsage ?? '').trim();
      const plannedExtract = String(record.plannedExtract ?? '').trim();
      const plannedNotes = String(record.plannedNotes ?? '').trim();
      if (plannedUsage) entry.plannedUsage = plannedUsage;
      if (plannedExtract) entry.plannedExtract = plannedExtract;
      if (plannedNotes) entry.plannedNotes = plannedNotes;
      results.push(entry);
    });

    return results;
  }

  private resolveCandidate(context: Record<string, unknown> | null): CandidateDataset {
    const compareCandidateId = String(context?.compareCandidateId ?? '').trim();
    const selectedIds = Array.isArray(context?.selectedDatasets)
      ? context.selectedDatasets.map((item) => String(item))
      : [];
    const rawCandidates = Array.isArray(context?.candidateDatasets) ? context.candidateDatasets : [];
    const normalized = rawCandidates
      .map((item) => this.normalizeCandidate(item))
      .filter((item): item is CandidateDataset => Boolean(item));

    if (compareCandidateId) {
      const explicit = normalized.find((item) => item.id === compareCandidateId);
      if (explicit) return explicit;
    }

    const picked = normalized.find((item) => selectedIds.includes(item.id))
      ?? normalized.sort((a, b) => b.score - a.score)[0];

    if (picked) return picked;

    const domainForm = (context?.domainForm && typeof context.domainForm === 'object')
      ? context.domainForm as Record<string, string>
      : {};

    return {
      id: 'domain-ideal-candidate',
      name: '도메인 정의 기준 이상 후보',
      description: [
        domainForm.industry,
        domainForm.subdomain,
        domainForm.ml_task,
        domainForm.target_event,
        domainForm.include_scope,
      ].filter(Boolean).join(' · ') || '외부 탐색 후보 미선택 — 도메인 스펙 기준 비교',
      modality: domainForm.data_modality || '시계열 구조화 데이터',
      rowsHint: domainForm.row_unit || '환자-입원-시점 단위',
      score: 0,
      matchedKeywords: [],
      provider: 'domain-spec',
    };
  }

  private normalizeCandidate(raw: unknown): CandidateDataset | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? '').trim();
    if (!id) return null;
    const resourcePlanRaw = item.resourcePlan;
    const resourcePlan = resourcePlanRaw && typeof resourcePlanRaw === 'object'
      ? {
        extractVariables: String((resourcePlanRaw as Record<string, unknown>).extractVariables ?? '').trim(),
        extractLabel: String((resourcePlanRaw as Record<string, unknown>).extractLabel ?? '').trim(),
        rowUnit: String((resourcePlanRaw as Record<string, unknown>).rowUnit ?? '').trim(),
        usagePurpose: String((resourcePlanRaw as Record<string, unknown>).usagePurpose ?? '').trim(),
        notes: String((resourcePlanRaw as Record<string, unknown>).notes ?? '').trim(),
      }
      : undefined;
    const rowsHint = resourcePlan?.rowUnit || String(item.rowsHint ?? '').trim();
    const descriptionParts = [
      String(item.description ?? '').trim(),
      resourcePlan?.usagePurpose ? `[활용] ${resourcePlan.usagePurpose}` : '',
      resourcePlan?.extractVariables ? `[발췌 변수] ${resourcePlan.extractVariables}` : '',
      resourcePlan?.extractLabel ? `[라벨] ${resourcePlan.extractLabel}` : '',
      resourcePlan?.notes ? `[메모] ${resourcePlan.notes}` : '',
    ].filter(Boolean);
    const extractTokens = (resourcePlan?.extractVariables ?? '')
      .split(/[,;\n|]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const matchedKeywords = Array.isArray(item.matchedKeywords)
      ? item.matchedKeywords.map((value) => String(value)).filter(Boolean)
      : [];
    extractTokens.forEach((token) => {
      if (!matchedKeywords.includes(token)) matchedKeywords.push(token);
    });
    return {
      id,
      name: String(item.name ?? id).trim(),
      description: descriptionParts.join(' · '),
      modality: String(item.modality ?? '').trim(),
      rowsHint,
      score: Number(item.score ?? 0) || 0,
      matchedKeywords,
      provider: String(item.provider ?? 'external').trim(),
      resourcePlan,
    };
  }

  private async buildCurrentDataSummary(
    dataSourceId: string | null,
    analysis: DataSourceAnalysisResult | null,
    domainForm: ReturnType<PipelineMatchingExecutionService['resolveDomainForm']>,
    domainVisuals: PipelineStepDomainVisuals | null,
  ): Promise<CurrentDataSummary> {
    let fileName = analysis?.fileName ?? '(unknown)';
    let rowCount = analysis?.rowCountEstimate ?? 0;
    let columns = analysis?.columnNames ?? [];
    let sampleRows: Record<string, string>[] = [];

    if (dataSourceId?.trim()) {
      const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId.trim());
      if (sample?.content?.length) {
        fileName = sample.fileName;
        sampleRows = this.parseRows(sample.content.toString('utf8'));
        if (sampleRows.length) {
          columns = Object.keys(sampleRows[0] ?? {});
          rowCount = sampleRows.length;
        }
      }
    }

    const targetColumn = analysis?.targetColumn
      ?? domainVisuals?.targetColumn
      ?? columns.find((column) => /label|target|warning|class|outcome/i.test(column))
      ?? null;

    return {
      fileName,
      rowCount: rowCount || sampleRows.length,
      columnCount: columns.length,
      columns,
      dataModality: domainForm.data_modality || analysis?.dataModality || '미정',
      rowUnit: domainForm.row_unit || analysis?.rowUnit || '미정',
      targetColumn,
      targetLabel: analysis?.targetLabel ?? domainVisuals?.targetLabel ?? null,
      mlTask: domainForm.ml_task || '미정',
      targetEvent: domainForm.target_event || targetColumn || '미정',
      includeScope: domainForm.include_scope || '',
      excludeScope: domainForm.exclude_scope || '',
      observationWindow: domainVisuals?.predictionHorizon?.observation || '미정',
      labelRules: (domainVisuals?.labelRules ?? []).map((rule) => `${rule.label}: ${rule.definition}`),
      columnMeanings: (domainVisuals?.columnMappings ?? [])
        .slice(0, 12)
        .map((row) => `${row.column}=${row.meaning}`),
      sampleRows: sampleRows.slice(0, 8),
    };
  }

  private parseRows(content: string): Record<string, string>[] {
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    return (parsed.data ?? []).filter((row) => row && typeof row === 'object');
  }

  private compareText(current: string, candidate: string): MatchingComparisonRow['result'] {
    const left = current.trim().toLowerCase();
    const right = candidate.trim().toLowerCase();
    if (!left || !right || left === '미정' || right === '미정') return '부분 적합';
    if (left === right) return '적합';
    if (left.includes(right) || right.includes(left)) return '부분 적합';
    if (this.hasSynonymOverlap(left, right)) return '부분 적합';

    const leftTokens = new Set(left.split(/[\s,/|·:;+]+/).filter((token) => token.length >= 2));
    const rightTokens = right.split(/[\s,/|·:;+]+/).filter((token) => token.length >= 2);
    const overlap = rightTokens.filter((token) => leftTokens.has(token)).length;
    if (overlap >= Math.max(1, Math.floor(rightTokens.length * 0.2))) return '부분 적합';
    if (overlap >= 1) return '부분 적합';
    return '부적합';
  }

  private hasSynonymOverlap(left: string, right: string): boolean {
    const inGroup = (text: string, group: string[]) =>
      group.some((term) => text.includes(term.toLowerCase()));
    if (TEXT_SYNONYM_GROUPS.some((group) => inGroup(left, group) && inGroup(right, group))) {
      return true;
    }
    return ROW_UNIT_SYNONYMS.some((group) => inGroup(left, group) && inGroup(right, group));
  }

  private compareExtractVariables(
    current: CurrentDataSummary,
    candidate: CandidateDataset,
  ): MatchingComparisonRow['result'] {
    const planned = String(candidate.resourcePlan?.extractVariables ?? '').trim();
    const candidateTokens = [
      ...planned.split(/[,;\n|+]+/).map((token) => token.trim()).filter(Boolean),
      ...candidate.matchedKeywords,
    ];
    if (!candidateTokens.length) return '부분 적합';

    const columnTokens = current.columns.map((column) => column.toLowerCase());
    const meaningTokens = current.columnMeanings
      .flatMap((item) => item.split(/[=:]/))
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);

    let hits = 0;
    candidateTokens.forEach((token) => {
      const normalized = token.toLowerCase();
      if (
        columnTokens.some((column) => column.includes(normalized) || normalized.includes(column))
        || meaningTokens.some((meaning) => meaning.includes(normalized) || normalized.includes(meaning))
        || this.hasSynonymOverlap(normalized, columnTokens.join(' '))
      ) {
        hits += 1;
      }
    });

    if (hits >= Math.max(1, Math.ceil(candidateTokens.length * 0.3))) return '적합';
    if (hits >= 1) return '부분 적합';
    return '부분 적합';
  }

  private compareLabelSemantics(current: CurrentDataSummary, candidate: CandidateDataset): MatchingComparisonRow['result'] {
    const currentLabel = [current.targetEvent, current.targetLabel, ...current.labelRules].join(' ').toLowerCase();
    const candidateText = [
      candidate.resourcePlan?.extractLabel,
      candidate.description,
      ...candidate.matchedKeywords,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!currentLabel.trim() || currentLabel.includes('미정')) return '부분 적합';
    if (/warning|label|event|adverse|cardiac|arrhythmia|heart|이상|사건|악화|target|outcome|flag/.test(candidateText)
      && /warning|label|event|adverse|cardiac|arrhythmia|heart|이상|사건|악화|target|outcome|flag/.test(currentLabel)) {
      return '부분 적합';
    }
    return this.compareText(currentLabel, candidateText);
  }

  private buildComparisonRows(
    current: CurrentDataSummary,
    candidate: CandidateDataset,
    domainVisuals: PipelineStepDomainVisuals | null,
  ): MatchingComparisonRow[] {
    const currentModality = current.dataModality;
    const candidateModality = candidate.modality || '미정';
    const currentRowUnit = current.rowUnit;
    const candidateRowUnit = candidate.resourcePlan?.rowUnit || candidate.rowsHint || '미정';
    const currentSemantics = current.columnMeanings.length
      ? current.columnMeanings.join('; ')
      : current.columns.slice(0, 6).join(', ');
    const candidateSemantics = [
      candidate.resourcePlan?.extractVariables,
      candidate.description,
      candidate.matchedKeywords.join(', '),
    ].filter(Boolean).join(' · ') || '설명 없음';
    const candidateLabelText = candidate.resourcePlan?.extractLabel
      || candidate.description
      || candidate.matchedKeywords.join(', ')
      || '미정';

    const rows: MatchingComparisonRow[] = [
      {
        item: '발췌 변수·컬럼',
        current: currentSemantics,
        candidate: candidate.resourcePlan?.extractVariables || candidateSemantics,
        result: this.compareExtractVariables(current, candidate),
      },
      {
        item: '데이터 형태',
        current: currentModality,
        candidate: candidateModality,
        result: this.compareText(currentModality, candidateModality),
      },
      {
        item: '라벨 의미',
        current: current.targetEvent + (current.targetLabel ? ` (${current.targetLabel})` : ''),
        candidate: candidateLabelText,
        result: this.compareLabelSemantics(current, candidate),
      },
      {
        item: '행 단위',
        current: currentRowUnit,
        candidate: candidateRowUnit,
        result: this.compareText(currentRowUnit, candidateRowUnit),
      },
      {
        item: '임상 변수 의미',
        current: currentSemantics,
        candidate: candidateSemantics,
        result: this.compareText(currentSemantics, candidateSemantics),
      },
      {
        item: '시계열 해상도',
        current: current.observationWindow,
        candidate: candidate.description.includes('hour') || candidate.description.includes('시간')
          ? candidate.description
          : (candidate.rowsHint || '미정'),
        result: this.compareText(
          current.observationWindow,
          domainVisuals?.predictionHorizon?.prediction || candidate.description,
        ),
      },
      {
        item: '환자군·포함 범위',
        current: current.includeScope || '미정',
        candidate: candidate.description || '미정',
        result: this.compareText(current.includeScope, candidate.description),
      },
    ];

    return rows;
  }

  private deriveFinalFit(rows: MatchingComparisonRow[]): PipelineStepMatchingVisuals['finalFit'] {
    const bad = rows.filter((row) => row.result === '부적합').length;
    const partial = rows.filter((row) => row.result === '부분 적합').length;
    const good = rows.filter((row) => row.result === '적합').length;
    const extractRow = rows.find((row) => row.item === '발췌 변수·컬럼');
    const hasMergeAnchor = good > 0
      || partial >= 2
      || extractRow?.result !== '부적합';

    if (bad >= 4 && !hasMergeAnchor) return '부적합';
    if (bad >= 2 && partial === 0 && good === 0) return '부적합';
    if (bad >= 1 || partial >= 1) return '부분 적합';
    return '적합';
  }

  private deriveActionPlan(finalFit: PipelineStepMatchingVisuals['finalFit']): string {
    if (finalFit === '적합') return '즉시 병합 적용';
    if (finalFit === '부분 적합') return '공통 변수만 병합 후 검증';
    return '참조·벤치마크만 활용';
  }

  private buildMergeGuidance(
    rows: MatchingComparisonRow[],
    candidate: CandidateDataset,
    current: CurrentDataSummary,
    finalFit: PipelineStepMatchingVisuals['finalFit'],
  ): NonNullable<PipelineStepMatchingVisuals['mergeGuidance']> {
    const mergeableAspects = rows
      .filter((row) => row.result !== '부적합')
      .map((row) => `${row.item}: ${row.result}`);
    const cautionAspects = rows
      .filter((row) => row.result === '부적합')
      .map((row) => `${row.item} — 후보(${row.candidate}) vs 현재(${row.current})`);

    const plannedTokens = String(candidate.resourcePlan?.extractVariables ?? '')
      .split(/[,;\n|+]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const suggestedColumns = current.columns.filter((column) => {
      const lower = column.toLowerCase();
      return plannedTokens.some((token) => {
        const normalized = token.toLowerCase();
        return lower.includes(normalized) || normalized.includes(lower);
      });
    }).slice(0, 8);

    let recommendation = '공통 변수 중심으로 단계적 병합을 권장합니다.';
    if (finalFit === '적합') {
      recommendation = '스키마·라벨 정합성이 충분합니다. 발췌 계획대로 병합을 진행해도 됩니다.';
    } else if (finalFit === '부분 적합') {
      recommendation = '겹치는 변수·라벨만 먼저 병합하고, 행 단위·환자군 차이는 매핑 규칙을 둔 뒤 검증하세요.';
    } else if (suggestedColumns.length > 0) {
      recommendation = '전체 병합은 비권장이지만, 겹치는 컬럼은 보조 특징으로 단계적 통합할 수 있습니다.';
    } else {
      recommendation = '직접 병합보다 라벨 정의·벤치마크 참조용으로 활용하는 편이 안전합니다.';
    }

    if (candidate.resourcePlan?.usagePurpose?.includes('벤치마크')) {
      recommendation += ' (탐색 단계에서 벤치마크 목적으로 지정됨)';
    }

    return {
      recommendation,
      mergeableAspects,
      cautionAspects,
      suggestedColumns,
    };
  }

  private scoreFromRows(rows: MatchingComparisonRow[]): number {
    if (!rows.length) return 0;
    const score = rows.reduce((sum, row) => {
      if (row.result === '적합') return sum + 100;
      if (row.result === '부분 적합') return sum + 78;
      return sum + 45;
    }, 0);
    return Math.round(score / rows.length);
  }

  private runCodeBasedSubTasks(
    addonIds: string[],
    current: CurrentDataSummary,
    candidate: CandidateDataset,
    comparisonRows: MatchingComparisonRow[],
    domainVisuals: PipelineStepDomainVisuals | null,
  ): MatchingSubTaskResult[] {
    const rowByItem = new Map(comparisonRows.map((row) => [row.item, row]));
    return addonIds.map((id) => {
      const meta = MATCHING_ADDON_CATALOG[id];
      if (id === 'addon_match_clinical_semantics') {
        const row = rowByItem.get('임상 변수 의미');
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: row ? `${row.result} — 현재 컬럼 의미 vs 후보 설명` : '임상 의미 비교 완료',
          findings: [
            `현재: ${row?.current || current.columnMeanings.slice(0, 3).join(', ')}`,
            `후보: ${row?.candidate || candidate.description}`,
            ...(domainVisuals?.columnMappings ?? []).slice(0, 3).map((item) => `${item.column} → ${item.meaning}`),
          ].filter(Boolean),
        };
      }
      if (id === 'addon_match_label_consistency') {
        const row = rowByItem.get('라벨 의미');
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: row ? `라벨 정합성 ${row.result}` : '라벨 기준 비교 완료',
          findings: [
            `현재 타깃: ${current.targetColumn || '미지정'} / ${current.targetEvent}`,
            ...current.labelRules.slice(0, 3),
            `후보 키워드: ${candidate.matchedKeywords.slice(0, 4).join(', ') || candidate.description}`,
          ].filter(Boolean),
        };
      }
      if (id === 'addon_match_temporal_resolution') {
        const row = rowByItem.get('시계열 해상도');
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: row ? `시계열 해상도 ${row.result}` : '시계열 비교 완료',
          findings: [
            `관찰 구간: ${current.observationWindow}`,
            domainVisuals?.predictionHorizon?.prediction
              ? `예측 구간: ${domainVisuals.predictionHorizon.prediction}`
              : '',
            `후보: ${row?.candidate || candidate.rowsHint || candidate.description}`,
          ].filter(Boolean),
        };
      }
      if (id === 'addon_match_population_distribution') {
        const row = rowByItem.get('환자군·포함 범위');
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: row ? `환자군 정합성 ${row.result}` : '환자군 비교 완료',
          findings: [
            current.includeScope ? `포함: ${current.includeScope}` : '포함 범위 미정',
            current.excludeScope ? `제외: ${current.excludeScope}` : '',
            `후보 설명: ${candidate.description}`,
          ].filter(Boolean),
        };
      }
      if (id === 'addon_match_physio_range') {
        const vitalMappings = (domainVisuals?.columnMappings ?? []).filter((item) => item.role === 'vital');
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: vitalMappings.length
            ? `생체신호 변수 ${vitalMappings.length}개 범위 검토`
            : '수치 컬럼 기반 범위 검토',
          findings: vitalMappings.length
            ? vitalMappings.slice(0, 4).map((item) => `${item.column}: ${item.meaning}`)
            : current.columns.filter((column) => /value|num|hr|bp|temp|spo2/i.test(column)).slice(0, 4)
              .map((column) => `${column} 샘플 값 확인 필요`),
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

  private async requestLlmMatching(input: {
    current: CurrentDataSummary;
    candidate: CandidateDataset;
    domainForm: ReturnType<PipelineMatchingExecutionService['resolveDomainForm']>;
    domainVisuals: PipelineStepDomainVisuals | null;
    selectedAddonIds: string[];
    comparisonRows: MatchingComparisonRow[];
    diagnosisSummary: string;
    qualityCheck: unknown;
    priorEvidence: unknown;
    candidateKnowledge?: CandidateKnowledge[];
  }): Promise<{
    subTaskResults: MatchingSubTaskResult[];
    comparisonRows: MatchingComparisonRow[];
    finalFit: PipelineStepMatchingVisuals['finalFit'];
    actionPlan: string;
    summaryNote: string;
  }> {
    const addonPrompt = input.selectedAddonIds.map((id) => {
      const meta = MATCHING_ADDON_CATALOG[id];
      return `- ${id}: ${meta?.label ?? id} — ${meta?.description ?? ''}`;
    }).join('\n');

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_matching_execution',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary_note: { type: 'string' },
          final_fit: { type: 'string', enum: ['적합', '부분 적합', '부적합'] },
          action_plan: { type: 'string' },
          comparison_rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                item: { type: 'string' },
                current: { type: 'string' },
                candidate: { type: 'string' },
                result: { type: 'string', enum: ['적합', '부분 적합', '부적합'] },
              },
              required: ['item', 'current', 'candidate', 'result'],
            },
          },
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
        required: ['summary_note', 'final_fit', 'action_plan', 'comparison_rows', 'sub_tasks'],
      },
      systemPrompt: [
        'You compare current clinical ML dataset against an external candidate for semantic compatibility.',
        'Use domain definition, diagnosis, column semantics, label rules, and candidate metadata.',
        'Do not ignore prior pipeline steps — base comparison on provided current data profile.',
        'Respond in Korean.',
      ].join(' '),
      userPrompt: [
        'Current data profile:',
        JSON.stringify({
          file: input.current.fileName,
          rows: input.current.rowCount,
          columns: input.current.columns,
          modality: input.current.dataModality,
          row_unit: input.current.rowUnit,
          target_column: input.current.targetColumn,
          target_event: input.current.targetEvent,
          label_rules: input.current.labelRules,
          column_meanings: input.current.columnMeanings,
          observation_window: input.current.observationWindow,
          include_scope: input.current.includeScope,
          exclude_scope: input.current.excludeScope,
          sample_rows: input.current.sampleRows,
        }, null, 2),
        'Domain form:',
        JSON.stringify(input.domainForm, null, 2),
        'Domain visuals:',
        JSON.stringify(input.domainVisuals ?? {}, null, 2),
        `Diagnosis: ${input.diagnosisSummary}`,
        'Quality check:',
        JSON.stringify(input.qualityCheck ?? {}, null, 2),
        'Prior step evidence:',
        JSON.stringify(input.priorEvidence ?? {}, null, 2),
        'Candidate dataset:',
        JSON.stringify(input.candidate, null, 2),
        'Initial comparison rows:',
        JSON.stringify(input.comparisonRows, null, 2),
        'Sub-tasks:',
        addonPrompt,
      ].join('\n'),
    });

    const payload = JSON.parse(raw) as {
      summary_note?: string;
      final_fit?: string;
      action_plan?: string;
      comparison_rows?: Array<{ item?: string; current?: string; candidate?: string; result?: string }>;
      sub_tasks?: Array<{ addon_id?: string; summary?: string; findings?: string[]; status?: string }>;
    };

    const subTaskResults = (payload.sub_tasks ?? [])
      .filter((item) => item?.addon_id && MATCHING_ADDON_CATALOG[item.addon_id])
      .map((item) => ({
        id: String(item.addon_id),
        label: MATCHING_ADDON_CATALOG[String(item.addon_id)].label,
        status: item.status === 'failed' ? 'failed' as const : 'done' as const,
        summary: String(item.summary ?? '').trim() || '분석 완료',
        findings: Array.isArray(item.findings) ? item.findings.map(String).filter(Boolean) : [],
      }));

    const comparisonRows = (payload.comparison_rows ?? [])
      .filter((row) => row?.item)
      .map((row) => ({
        item: String(row.item),
        current: String(row.current ?? '').trim(),
        candidate: String(row.candidate ?? '').trim(),
        result: (['적합', '부분 적합', '부적합'].includes(String(row.result))
          ? row.result
          : '부분 적합') as MatchingComparisonRow['result'],
      }));

    const finalFit = (['적합', '부분 적합', '부적합'].includes(String(payload.final_fit))
      ? payload.final_fit
      : '부분 적합') as PipelineStepMatchingVisuals['finalFit'];

    return {
      subTaskResults,
      comparisonRows,
      finalFit,
      actionPlan: String(payload.action_plan ?? '').trim() || this.deriveActionPlan(finalFit),
      summaryNote: String(payload.summary_note ?? '').trim(),
    };
  }

  private mergeSubTaskResults(
    codeResults: MatchingSubTaskResult[],
    llmResults: MatchingSubTaskResult[],
  ): MatchingSubTaskResult[] {
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
}
