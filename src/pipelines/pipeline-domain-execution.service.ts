import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { StoreService } from '../store/store.service';

export type DomainSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type DomainFormSnapshot = {
  industry: string;
  subdomain: string;
  data_modality: string;
  row_unit: string;
  ml_task: string;
  target_event: string;
  include_scope: string;
  exclude_scope: string;
};

export type PipelineStepDomainVisuals = {
  domainForm: DomainFormSnapshot;
  targetColumn: string | null;
  targetLabel: string | null;
  columnMappings: Array<{ column: string; meaning: string; role: string }>;
  labelRules: Array<{ label: string; definition: string }>;
  predictionHorizon: { observation: string; prediction: string } | null;
  anomalySubtypes: string[];
};

export type DomainExecutionResult = {
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  subTaskResults: DomainSubTaskResult[];
  domainVisuals: PipelineStepDomainVisuals;
  domainForm: DomainFormSnapshot;
};

type DomainVisuals = PipelineStepDomainVisuals;

type ColumnValueProfile = {
  column: string;
  inferredType: 'numeric' | 'categorical' | 'datetime' | 'id' | 'text' | 'unknown';
  distinctCount: number;
  sampleValues: string[];
  numericMin: number | null;
  numericMax: number | null;
  nullRatePercent: number;
};

const CLINICAL_NAME_PATTERNS: Array<[RegExp, string, string]> = [
  [/heart\s*rate|pulse|hr\b/i, '심박수', 'vital'],
  [/blood\s*pressure|nbp|abp|sbp|dbp|map\b/i, '혈압', 'vital'],
  [/spo2|oxygen|o2\s*sat/i, '산소포화도', 'vital'],
  [/temperature|temp\b/i, '체온', 'vital'],
  [/resp|rr\b|breath/i, '호흡수', 'vital'],
  [/rhythm|ectopy|afib|sinus/i, '심전도/리듬', 'vital'],
  [/glucose|hba1c/i, '혈당', 'lab'],
  [/creatinine|bun|gfr/i, '신기능 검사', 'lab'],
  [/wbc|rbc|hemoglobin|platelet/i, '혈액검사', 'lab'],
];

const DOMAIN_ADDON_CATALOG: Record<string, { label: string; description: string }> = {
  addon_dom_label_mapping_clinical: {
    label: '정상·이상 라벨 매핑',
    description: '임상 결과 기준으로 라벨 규칙을 정의합니다.',
  },
  addon_dom_prediction_horizon: {
    label: '예측 시점·관찰 구간 설정',
    description: '관찰 구간과 예측 시점을 정의합니다.',
  },
  addon_dom_variable_semantics: {
    label: '임상 변수 의미 매핑',
    description: '컬럼명을 임상 의미와 연결합니다.',
  },
  addon_dom_anomaly_subtype: {
    label: '이상 유형 세분화',
    description: '이상 유형을 하위 카테고리로 구분합니다.',
  },
  addon_dom_cohort_inclusion: {
    label: '분석 대상 환자군·제외 기준 설정',
    description: '포함·제외 코호트 기준을 설정합니다.',
  },
};

const DEFAULT_DOMAIN_ADDON_IDS = [
  'addon_dom_label_mapping_clinical',
  'addon_dom_prediction_horizon',
  'addon_dom_variable_semantics',
  'addon_dom_anomaly_subtype',
];

@Injectable()
export class PipelineDomainExecutionService {
  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
  ) {}

  async execute(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<DomainExecutionResult> {
    void actorUserId;
    void pipelineId;

    const baseForm = this.mergeDomainForm(analysis, context);
    let columnNames = analysis?.columnNames ?? [];
    let fileName = analysis?.fileName ?? '(unknown)';
    let rowCount = analysis?.rowCountEstimate ?? null;
    let sampleRows: Record<string, string>[] = [];

    if (dataSourceId?.trim()) {
      const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
      if (sample?.content?.length) {
        fileName = sample.fileName;
        sampleRows = this.parseRows(sample.content.toString('utf8'));
        if (sampleRows.length) {
          columnNames = Object.keys(sampleRows[0] ?? {});
          rowCount = sampleRows.length;
        }
      }
    }

    if (!columnNames.length && !baseForm.industry && !baseForm.ml_task) {
      throw new BadRequestException('도메인 정의에 사용할 데이터 또는 도메인 초안이 없습니다.');
    }

    const selectedAddonIds = this.resolveSelectedAddonIds(context);
    const targetColumn = this.resolveTargetColumn(columnNames, analysis);
    const columnProfiles = this.buildColumnValueProfiles(sampleRows, columnNames);
    const codeSubTasks = this.runCodeBasedSubTasks(
      selectedAddonIds,
      columnNames,
      sampleRows,
      targetColumn,
      baseForm,
      columnProfiles,
    );

    let llmUsed = false;
    let subTaskResults = codeSubTasks;
    let refinedForm = { ...baseForm };
    let columnMappings = this.heuristicColumnMappings(columnNames, sampleRows, columnProfiles);
    let labelRules = this.heuristicLabelRules(sampleRows, targetColumn);
    let predictionHorizon = this.heuristicPredictionHorizon(columnNames);
    let anomalySubtypes = ['급성 악화', '생체신호 이상', '검사 이상'];

    if (this.llmClient.isConfigured()) {
      try {
        const llm = await this.requestLlmDomain({
          analysis,
          baseForm,
          selectedAddonIds,
          columnNames,
          sampleRows: sampleRows.slice(0, 10),
          columnProfiles,
          fileName,
          targetColumn,
          diagnosisSummary: analysis?.diagnosisSummary ?? '',
        });
        subTaskResults = this.mergeSubTaskResults(codeSubTasks, llm.subTaskResults);
        refinedForm = { ...refinedForm, ...llm.domainForm };
        if (llm.columnMappings.length) {
          columnMappings = this.mergeColumnMappings(
            this.heuristicColumnMappings(columnNames, sampleRows, columnProfiles),
            llm.columnMappings,
          );
        }
        if (llm.labelRules.length) labelRules = llm.labelRules;
        if (llm.predictionHorizon) predictionHorizon = llm.predictionHorizon;
        if (llm.anomalySubtypes.length) anomalySubtypes = llm.anomalySubtypes;
        llmUsed = true;
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    const domainVisuals: DomainVisuals = {
      domainForm: refinedForm,
      targetColumn,
      targetLabel: analysis?.targetLabel ?? null,
      columnMappings: columnMappings.slice(0, 16),
      labelRules: labelRules.slice(0, 8),
      predictionHorizon,
      anomalySubtypes: anomalySubtypes.slice(0, 8),
    };

    const evidence = [
      `[도메인] ${refinedForm.industry || '미정'} · ${refinedForm.ml_task || 'ML task 미정'}`,
      refinedForm.target_event ? `[타깃] ${refinedForm.target_event}` : '',
      targetColumn ? `[타깃 컬럼] ${targetColumn}` : '',
      refinedForm.include_scope ? `[포함] ${refinedForm.include_scope}` : '',
      refinedForm.exclude_scope ? `[제외] ${refinedForm.exclude_scope}` : '',
      ...subTaskResults.slice(0, 4).map((item) => `[${item.label}] ${item.summary}`),
    ].filter(Boolean);

    const summary = llmUsed
      ? `도메인 정의 LLM 실행 완료 (${subTaskResults.length}개 세부 작업)`
      : `도메인 정의 점검 완료 (${subTaskResults.length}개 세부 작업)`;

    return {
      summary,
      inputSummary: `${fileName} · ${rowCount ?? '?'}행 · ${columnNames.length}컬럼`,
      evidence,
      expectedResult: '도메인·태스크·스코프 초안 확정',
      llmUsed: llmUsed || Boolean(analysis?.llmUsed),
      subTaskResults,
      domainVisuals,
      domainForm: refinedForm,
    };
  }

  private mergeDomainForm(
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): DomainFormSnapshot {
    const fromContext = (context?.domainForm && typeof context.domainForm === 'object')
      ? context.domainForm as Record<string, string>
      : {};
    const fromAnalysis: Partial<DomainFormSnapshot> = analysis?.domainForm ?? {};
    return {
      industry: fromContext.industry || fromAnalysis.industry || '',
      subdomain: fromContext.subdomain || fromAnalysis.subdomain || '',
      data_modality: fromContext.data_modality || fromAnalysis.data_modality || '',
      row_unit: fromContext.row_unit || fromAnalysis.row_unit || '',
      ml_task: fromContext.ml_task || fromAnalysis.ml_task || '',
      target_event: fromContext.target_event || fromAnalysis.target_event || '',
      include_scope: fromContext.include_scope || fromAnalysis.include_scope || '',
      exclude_scope: fromContext.exclude_scope || fromAnalysis.exclude_scope || '',
    };
  }

  private resolveSelectedAddonIds(context: Record<string, unknown> | null): string[] {
    const raw = context?.selectedAddonIds;
    const ids = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter((id) => DOMAIN_ADDON_CATALOG[id])
      : [];
    return ids.length > 0 ? ids : DEFAULT_DOMAIN_ADDON_IDS;
  }

  private resolveTargetColumn(columnNames: string[], analysis: DataSourceAnalysisResult | null): string | null {
    const explicit = analysis?.targetColumn?.trim();
    if (explicit && columnNames.includes(explicit)) return explicit;
    const targetEvent = analysis?.domainForm?.target_event?.trim() ?? '';
    const eqMatch = targetEvent.match(/^([A-Za-z0-9_]+)\s*=/);
    if (eqMatch?.[1] && columnNames.includes(eqMatch[1])) return eqMatch[1];
    const included = columnNames.find((column) => targetEvent.includes(column));
    if (included) return included;
    return columnNames.find((column) => /label|target|class|result|outcome|flag|warning/i.test(column)) ?? null;
  }

  private parseRows(content: string): Record<string, string>[] {
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    return (parsed.data ?? []).filter((row) => row && typeof row === 'object');
  }

  private buildColumnValueProfiles(
    rows: Record<string, string>[],
    columnNames: string[],
    maxRows = 600,
  ): ColumnValueProfile[] {
    if (!rows.length || !columnNames.length) return [];

    const sample = rows.slice(0, maxRows);
    return columnNames.map((column) => {
      const values = sample.map((row) => String(row[column] ?? '').trim());
      const nonEmpty = values.filter(Boolean);
      const distinct = [...new Set(nonEmpty)];
      const nullRatePercent = sample.length
        ? ((sample.length - nonEmpty.length) / sample.length) * 100
        : 0;

      const numericValues = nonEmpty
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      const numericRatio = nonEmpty.length ? numericValues.length / nonEmpty.length : 0;

      let inferredType: ColumnValueProfile['inferredType'] = 'unknown';
      if (numericRatio >= 0.85) {
        inferredType = distinct.length > sample.length * 0.9 ? 'id' : 'numeric';
      } else if (this.looksLikeDatetime(nonEmpty)) {
        inferredType = 'datetime';
      } else if (distinct.length <= Math.min(24, Math.max(3, Math.floor(sample.length * 0.2)))) {
        inferredType = 'categorical';
      } else {
        inferredType = 'text';
      }

      const frequency = new Map<string, number>();
      for (const value of nonEmpty) {
        frequency.set(value, (frequency.get(value) ?? 0) + 1);
      }
      const sampleValues = [...frequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([value]) => value);

      return {
        column,
        inferredType,
        distinctCount: distinct.length,
        sampleValues,
        numericMin: numericValues.length ? Math.min(...numericValues) : null,
        numericMax: numericValues.length ? Math.max(...numericValues) : null,
        nullRatePercent,
      };
    });
  }

  private looksLikeDatetime(values: string[]): boolean {
    if (!values.length) return false;
    const hits = values.slice(0, 40).filter((value) =>
      /^\d{4}-\d{2}-\d{2}/.test(value)
      || /^\d{2}\/\d{2}\/\d{4}/.test(value)
      || /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    return hits.length >= Math.min(5, values.length) && hits.length / values.length >= 0.6;
  }

  private formatValueHint(profile: ColumnValueProfile): string {
    const samples = profile.sampleValues.slice(0, 4).filter(Boolean);
    if (!samples.length) return '';
    if (profile.inferredType === 'numeric' && profile.numericMin != null && profile.numericMax != null) {
      return `값 범위 ${profile.numericMin}~${profile.numericMax}`;
    }
    return `예: ${samples.join(', ')}`;
  }

  private inferMeaningFromMeasurementNames(rows: Record<string, string>[]): string | null {
    const nameColumn = ['column_name', 'item_name', 'measurement_name', 'label_name']
      .find((column) => rows[0] && column in rows[0]);
    if (!nameColumn) return null;

    const counts = new Map<string, number>();
    for (const row of rows.slice(0, 800)) {
      const name = String(row[nameColumn] ?? '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const topNames = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);
    if (!topNames.length) return null;

    const joined = topNames.join(' | ');
    for (const [pattern, meaning] of CLINICAL_NAME_PATTERNS) {
      if (pattern.test(joined)) return `${meaning} 항목 (${topNames.slice(0, 3).join(', ')} 등)`;
    }
    return `측정 항목명 (${topNames.slice(0, 3).join(', ')} 등)`;
  }

  private inferMeaningFromProfile(
    column: string,
    profile: ColumnValueProfile,
    rows: Record<string, string>[],
    measurementNameHint: string | null,
  ): { meaning: string; role: string } | null {
    const nameKey = column.toLowerCase();
    const sampleText = profile.sampleValues.join(' ').toLowerCase();
    const valueHint = this.formatValueHint(profile);

    const nameRules: Array<[RegExp, string, string]> = [
      [/heart|hr|pulse/i, '심박수', 'vital'],
      [/bp|blood.?pressure|sbp|dbp/i, '혈압', 'vital'],
      [/spo2|oxygen|o2/i, '산소포화도', 'vital'],
      [/temp|temperature/i, '체온', 'vital'],
      [/resp|rr|breath/i, '호흡수', 'vital'],
      [/warning|alert/i, '경고 플래그', 'target'],
      [/^(label|class|outcome|result)$/i, '라벨/결과', 'target'],
      [/time|date|chart|store/i, '시간', 'time'],
      [/patient|subject|hadm|stay/i, '환자/입원 ID', 'id'],
      [/itemid|item_id/i, '측정 항목 ID', 'id'],
      [/uom|unit/i, '측정 단위', 'feature'],
      [/category/i, '측정 카테고리', 'feature'],
      [/column_name|item_name|measurement_name/i, '측정 항목명', 'feature'],
      [/valuenum|measurement_value/i, '측정 수치', 'feature'],
      [/^value$/i, '측정값 (텍스트)', 'feature'],
    ];
    const nameHit = nameRules.find(([pattern]) => pattern.test(column));
    if (nameHit) {
      let meaning = nameHit[1];
      if (nameHit[1] === '측정 항목명' && measurementNameHint) {
        meaning = measurementNameHint;
      }
      if (valueHint) meaning = `${meaning} (${valueHint})`;
      return { meaning, role: nameHit[2] };
    }

    if (/itemid|item_id/i.test(nameKey) && profile.inferredType === 'numeric') {
      return {
        meaning: valueHint ? `측정 항목 코드 (${valueHint})` : '측정 항목 코드',
        role: 'id',
      };
    }

    if (/uom|unit/i.test(nameKey)) {
      const unitSamples = profile.sampleValues.slice(0, 5).join(', ');
      if (/mmhg|bpm|mg\/dl|g\/dl|%|celsius|fahrenheit|kg|ml|l\/min/i.test(sampleText)) {
        return { meaning: `측정 단위 (${unitSamples || valueHint})`, role: 'feature' };
      }
    }

    if (/category/i.test(nameKey)) {
      if (/vital|routine|blood|lab|chart/i.test(sampleText)) {
        return { meaning: `측정 카테고리 (${profile.sampleValues.slice(0, 4).join(', ')})`, role: 'feature' };
      }
    }

    if (/column_name|item_name|measurement_name/i.test(nameKey)) {
      return {
        meaning: measurementNameHint || `측정 항목명 (${profile.sampleValues.slice(0, 3).join(', ')})`,
        role: 'feature',
      };
    }

    if (/valuenum|measurement_value|numeric/i.test(nameKey) && profile.inferredType === 'numeric') {
      const min = profile.numericMin ?? 0;
      const max = profile.numericMax ?? 0;
      if (min >= 35 && max <= 42) return { meaning: `체온 수치 (${valueHint})`, role: 'vital' };
      if (min >= 50 && max <= 100 && max - min < 55) return { meaning: `산소포화도 수치 (${valueHint})`, role: 'vital' };
      if (min >= 40 && max <= 220) return { meaning: `맥박/심박 관련 수치 (${valueHint})`, role: 'vital' };
      if (min >= 40 && max <= 260) return { meaning: `혈압/맥박 관련 수치 (${valueHint})`, role: 'vital' };
      return { meaning: `임상 측정 수치 (${valueHint})`, role: 'feature' };
    }

    if (/^value$/i.test(column) || /text.?value/i.test(nameKey)) {
      if (/sinus|rhythm|ectopy|afib|vtach|brady/i.test(sampleText)) {
        return { meaning: `심전도/리듬 텍스트 소견 (${profile.sampleValues.slice(0, 3).join(', ')})`, role: 'feature' };
      }
      if (/\d+\s*\/\s*\d+/.test(sampleText)) {
        return { meaning: `혈압 텍스트 표현 (${profile.sampleValues.slice(0, 3).join(', ')})`, role: 'vital' };
      }
      if (profile.sampleValues.length) {
        return { meaning: `측정값 텍스트 (${profile.sampleValues.slice(0, 3).join(', ')})`, role: 'feature' };
      }
    }

    if (/warning|alert|flag/i.test(nameKey)) {
      const flagSamples = profile.sampleValues.slice(0, 4).join(', ');
      return { meaning: flagSamples ? `경고 플래그 (${flagSamples})` : '경고 플래그', role: 'target' };
    }

    if (/^label$/i.test(column)) {
      return { meaning: `라벨/결과 (${profile.sampleValues.slice(0, 4).join(', ')})`, role: 'target' };
    }

    for (const [pattern, meaning, role] of CLINICAL_NAME_PATTERNS) {
      if (pattern.test(sampleText)) {
        return { meaning: `${meaning} (${profile.sampleValues.slice(0, 3).join(', ')})`, role };
      }
    }

    if (profile.inferredType === 'datetime' || this.looksLikeDatetime(profile.sampleValues)) {
      return { meaning: `시간 (${valueHint})`, role: 'time' };
    }

    if (profile.inferredType === 'id' || (profile.inferredType === 'numeric' && profile.distinctCount > rows.length * 0.5)) {
      return { meaning: `식별자/코드 (${valueHint})`, role: 'id' };
    }

    if (profile.inferredType === 'categorical' && profile.distinctCount <= 8) {
      return { meaning: `범주형 변수 (${profile.sampleValues.join(', ')})`, role: 'feature' };
    }

    if (profile.inferredType === 'numeric' && valueHint) {
      return { meaning: `수치 변수 (${valueHint})`, role: 'feature' };
    }

    if (profile.sampleValues.length) {
      return { meaning: `미분류 (${profile.sampleValues.slice(0, 3).join(', ')})`, role: 'feature' };
    }

    return null;
  }

  private heuristicColumnMappings(
    columnNames: string[],
    rows: Record<string, string>[],
    profiles?: ColumnValueProfile[],
  ): DomainVisuals['columnMappings'] {
    const profileByColumn = new Map(
      (profiles ?? this.buildColumnValueProfiles(rows, columnNames)).map((profile) => [profile.column, profile]),
    );
    const measurementNameHint = this.inferMeaningFromMeasurementNames(rows);

    return columnNames.slice(0, 24).map((column) => {
      const profile = profileByColumn.get(column) ?? {
        column,
        inferredType: 'unknown' as const,
        distinctCount: 0,
        sampleValues: [],
        numericMin: null,
        numericMax: null,
        nullRatePercent: 0,
      };
      const inferred = this.inferMeaningFromProfile(column, profile, rows, measurementNameHint);
      if (inferred) return { column, ...inferred };
      return { column, meaning: '미분류 변수', role: 'feature' };
    });
  }

  private mergeColumnMappings(
    heuristic: DomainVisuals['columnMappings'],
    llm: DomainVisuals['columnMappings'],
  ): DomainVisuals['columnMappings'] {
    const llmByColumn = new Map(llm.map((item) => [item.column, item]));
    const merged = heuristic.map((item) => {
      const fromLlm = llmByColumn.get(item.column);
      if (!fromLlm) return item;
      const llmMeaning = String(fromLlm.meaning ?? '').trim();
      const isGeneric = !llmMeaning || /^미분류/.test(llmMeaning);
      if (isGeneric && item.meaning && !/^미분류/.test(item.meaning)) return item;
      return {
        column: item.column,
        meaning: llmMeaning || item.meaning,
        role: fromLlm.role || item.role,
      };
    });

    for (const item of llm) {
      if (!merged.some((row) => row.column === item.column)) {
        merged.push(item);
      }
    }
    return merged;
  }

  private compactProfilesForPrompt(profiles: ColumnValueProfile[]): Array<Record<string, unknown>> {
    return profiles.slice(0, 24).map((profile) => ({
      column: profile.column,
      type: profile.inferredType,
      distinct: profile.distinctCount,
      samples: profile.sampleValues.slice(0, 6),
      numeric_range: profile.numericMin != null && profile.numericMax != null
        ? [profile.numericMin, profile.numericMax]
        : null,
      null_rate_percent: Number(profile.nullRatePercent.toFixed(1)),
    }));
  }

  private heuristicLabelRules(
    rows: Record<string, string>[],
    targetColumn: string | null,
  ): DomainVisuals['labelRules'] {
    if (!targetColumn || !rows.length) {
      return [{ label: 'positive', definition: '이상/사건 발생' }, { label: 'negative', definition: '정상/사건 없음' }];
    }
    const counts: Record<string, number> = {};
    for (const row of rows.slice(0, 500)) {
      const key = String(row[targetColumn] ?? 'UNKNOWN').trim() || 'UNKNOWN';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({
        label,
        definition: `${targetColumn}=${label} (${count}건)`,
      }));
  }

  private heuristicPredictionHorizon(columnNames: string[]): { observation: string; prediction: string } {
    const timeCols = columnNames.filter((c) => /time|date|chart|store/i.test(c));
    if (!timeCols.length) {
      return { observation: '최근 24시간 관찰', prediction: '관찰 종료 후 24시간 이내' };
    }
    return {
      observation: `최근 구간 (${timeCols.slice(0, 2).join(', ')})`,
      prediction: '관찰 종료 시점 이후 24시간',
    };
  }

  private runCodeBasedSubTasks(
    addonIds: string[],
    columnNames: string[],
    rows: Record<string, string>[],
    targetColumn: string | null,
    form: DomainFormSnapshot,
    columnProfiles: ColumnValueProfile[],
  ): DomainSubTaskResult[] {
    return addonIds.map((id) => {
      const meta = DOMAIN_ADDON_CATALOG[id];
      if (id === 'addon_dom_variable_semantics') {
        const mappings = this.heuristicColumnMappings(columnNames, rows, columnProfiles).slice(0, 8);
        const classified = mappings.filter((item) => !/^미분류/.test(item.meaning)).length;
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `컬럼 ${columnNames.length}개 중 ${classified}개 값 기반 의미 추론`,
          findings: mappings.map((m) => `${m.column} → ${m.meaning} (${m.role})`),
        };
      }
      if (id === 'addon_dom_prediction_horizon') {
        const horizon = this.heuristicPredictionHorizon(columnNames);
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `관찰: ${horizon.observation}`,
          findings: [`예측: ${horizon.prediction}`],
        };
      }
      if (id === 'addon_dom_label_mapping_clinical') {
        const rules = this.heuristicLabelRules(rows, targetColumn);
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: targetColumn ? `${targetColumn} 기준 라벨 ${rules.length}개` : '타깃 컬럼 미지정 — 라벨 규칙 초안',
          findings: rules.map((r) => `${r.label}: ${r.definition}`),
        };
      }
      if (id === 'addon_dom_anomaly_subtype') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: '이상 유형 3종 초안',
          findings: ['급성 악화', '생체신호 이상', '검사 이상'],
        };
      }
      if (id === 'addon_dom_cohort_inclusion') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: form.include_scope ? '포함 범위 반영' : '코호트 기준 초안',
          findings: [
            form.include_scope ? `포함: ${form.include_scope}` : '포함 범위 미정',
            form.exclude_scope ? `제외: ${form.exclude_scope}` : '제외 범위 미정',
          ].filter(Boolean),
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

  private async requestLlmDomain(input: {
    analysis: DataSourceAnalysisResult | null;
    baseForm: DomainFormSnapshot;
    selectedAddonIds: string[];
    columnNames: string[];
    sampleRows: Record<string, string>[];
    columnProfiles: ColumnValueProfile[];
    fileName: string;
    targetColumn: string | null;
    diagnosisSummary: string;
  }): Promise<{
    domainForm: Partial<DomainFormSnapshot>;
    subTaskResults: DomainSubTaskResult[];
    columnMappings: DomainVisuals['columnMappings'];
    labelRules: DomainVisuals['labelRules'];
    predictionHorizon: DomainVisuals['predictionHorizon'];
    anomalySubtypes: string[];
  }> {
    const addonPrompt = input.selectedAddonIds.map((id) => {
      const meta = DOMAIN_ADDON_CATALOG[id];
      return `- ${id}: ${meta?.label ?? id} — ${meta?.description ?? ''}`;
    }).join('\n');

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_domain_execution',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain_form: {
            type: 'object',
            additionalProperties: false,
            properties: {
              industry: { type: 'string' },
              subdomain: { type: 'string' },
              data_modality: { type: 'string' },
              row_unit: { type: 'string' },
              ml_task: { type: 'string' },
              target_event: { type: 'string' },
              include_scope: { type: 'string' },
              exclude_scope: { type: 'string' },
            },
            required: ['industry', 'subdomain', 'data_modality', 'row_unit', 'ml_task', 'target_event', 'include_scope', 'exclude_scope'],
          },
          column_mappings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                column: { type: 'string' },
                meaning: { type: 'string' },
                role: { type: 'string' },
              },
              required: ['column', 'meaning', 'role'],
            },
          },
          label_rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                definition: { type: 'string' },
              },
              required: ['label', 'definition'],
            },
          },
          prediction_horizon: {
            type: 'object',
            additionalProperties: false,
            properties: {
              observation: { type: 'string' },
              prediction: { type: 'string' },
            },
            required: ['observation', 'prediction'],
          },
          anomaly_subtypes: { type: 'array', items: { type: 'string' } },
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
        required: ['domain_form', 'column_mappings', 'label_rules', 'prediction_horizon', 'anomaly_subtypes', 'sub_tasks'],
      },
      systemPrompt: [
        'You define ML domain specifications for a medical/clinical dataset workbench.',
        'Execute each listed sub-task and refine domain_form fields.',
        'For column_mappings, infer clinical meaning from BOTH column names AND actual sample values, units, categories, and numeric ranges.',
        'Long-format EHR tables (itemid/value/valuenum/valueuom/column_name) should be interpreted using value content, not left as unclassified.',
        'Respond in Korean for summaries and definitions.',
      ].join(' '),
      userPrompt: [
        `File: ${input.fileName}`,
        `Columns: ${input.columnNames.join(', ') || '(unknown)'}`,
        `Target column: ${input.targetColumn ?? '(unknown)'}`,
        `Diagnosis: ${input.diagnosisSummary}`,
        'Current domain form:',
        JSON.stringify(input.baseForm, null, 2),
        'Column value profiles (use for clinical inference):',
        JSON.stringify(this.compactProfilesForPrompt(input.columnProfiles), null, 2),
        'Sub-tasks:',
        addonPrompt,
        'Sample rows:',
        JSON.stringify(input.sampleRows.slice(0, 8), null, 2),
      ].join('\n'),
    });

    const payload = JSON.parse(raw) as {
      domain_form?: Partial<DomainFormSnapshot>;
      column_mappings?: Array<{ column?: string; meaning?: string; role?: string }>;
      label_rules?: Array<{ label?: string; definition?: string }>;
      prediction_horizon?: { observation?: string; prediction?: string };
      anomaly_subtypes?: string[];
      sub_tasks?: Array<{ addon_id?: string; summary?: string; findings?: string[]; status?: string }>;
    };

    const subTaskResults = (payload.sub_tasks ?? [])
      .filter((item) => item?.addon_id && DOMAIN_ADDON_CATALOG[item.addon_id])
      .map((item) => ({
        id: String(item.addon_id),
        label: DOMAIN_ADDON_CATALOG[String(item.addon_id)].label,
        status: item.status === 'failed' ? 'failed' as const : 'done' as const,
        summary: String(item.summary ?? '').trim() || '분석 완료',
        findings: Array.isArray(item.findings) ? item.findings.map(String).filter(Boolean) : [],
      }));

    return {
      domainForm: payload.domain_form ?? {},
      subTaskResults,
      columnMappings: (payload.column_mappings ?? [])
        .filter((item) => item?.column)
        .map((item) => ({
          column: String(item.column),
          meaning: String(item.meaning ?? '').trim() || '미분류',
          role: String(item.role ?? '').trim() || 'feature',
        })),
      labelRules: (payload.label_rules ?? [])
        .filter((item) => item?.label)
        .map((item) => ({
          label: String(item.label),
          definition: String(item.definition ?? '').trim() || '',
        })),
      predictionHorizon: payload.prediction_horizon?.observation
        ? {
          observation: String(payload.prediction_horizon.observation),
          prediction: String(payload.prediction_horizon.prediction ?? ''),
        }
        : null,
      anomalySubtypes: Array.isArray(payload.anomaly_subtypes)
        ? payload.anomaly_subtypes.map(String).filter(Boolean)
        : [],
    };
  }

  private mergeSubTaskResults(
    codeResults: DomainSubTaskResult[],
    llmResults: DomainSubTaskResult[],
  ): DomainSubTaskResult[] {
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
