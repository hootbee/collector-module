import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { StoreService } from '../store/store.service';
import { PipelineMissingImputationService } from './pipeline-missing-imputation.service';
import type { ImputationArtifactMeta } from './pipeline-missing-imputation.service';

export type DiagnosisSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type DiagnosisQualityCheck = {
  missingRisk: 'low' | 'medium' | 'high';
  imbalanceRisk: 'low' | 'medium' | 'high';
  overallVerdict: string;
  missingRatePercent: number;
  minorityClassRatio: number | null;
  targetColumn: string | null;
};

export type DiagnosisVisuals = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  targetColumn: string | null;
  missingRates: Array<{ column: string; ratePercent: number; missingCount: number }>;
  classDistribution: Array<{ label: string; count: number; ratioPercent: number }>;
};

export type DiagnosisImputationArtifact = {
  artifactId: string;
  fileName: string;
  downloadPath: string;
  rowCount: number;
  imputedCellCount: number;
  remainingMissingCount: number;
  columnsImputed: string[];
};

export type DiagnosisImputationOnlyResult = {
  imputationSummary: string | null;
  imputationArtifact: DiagnosisImputationArtifact | null;
  diagnosisVisuals: DiagnosisVisuals;
  llmUsed: boolean;
};

export type DiagnosisExecutionResult = {
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  qualityCheck: DiagnosisQualityCheck;
  subTaskResults: DiagnosisSubTaskResult[];
  diagnosisVisuals: DiagnosisVisuals;
  imputationArtifact?: DiagnosisImputationArtifact | null;
  imputationSummary?: string | null;
};

const DIAGNOSIS_ADDON_CATALOG: Record<string, { label: string; description: string }> = {
  addon_dx_anomaly_sparsity_deep: {
    label: '이상 클래스 희소성 심화 분석',
    description: '이상 클래스가 어떤 환자군·시점·변수 조건에서 부족한지 분석합니다.',
  },
  addon_dx_timeseries_missing_segments: {
    label: '시계열 결측 구간 분석',
    description: '시간 흐름에서 어느 구간이 비어 있는지 분석합니다.',
  },
  addon_dx_leakage_detection: {
    label: '데이터 누수 가능성 탐지',
    description: '예측 시점 이후 정보가 입력 변수에 섞였는지 점검합니다.',
  },
  addon_dx_class_boundary_overlap: {
    label: '클래스 경계 중첩 분석',
    description: '정상·이상 클래스가 변수 공간에서 얼마나 겹치는지 분석합니다.',
  },
  addon_dx_patient_level_duplicate: {
    label: '환자 단위 중복 진단',
    description: '동일 환자·입원 기록 중복 여부를 확인합니다.',
  },
};

const DEFAULT_DIAGNOSIS_ADDON_IDS = [
  'addon_dx_anomaly_sparsity_deep',
  'addon_dx_timeseries_missing_segments',
  'addon_dx_leakage_detection',
  'addon_dx_class_boundary_overlap',
];

@Injectable()
export class PipelineDiagnosisExecutionService {
  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
    private readonly imputationService: PipelineMissingImputationService,
  ) {}

  async execute(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<DiagnosisExecutionResult> {
    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('진단할 업로드 파일이 없습니다.');
    }

    const rows = this.parseRows(sample.content.toString('utf8'));
    if (!rows.length) {
      throw new BadRequestException('CSV에 분석 가능한 행이 없습니다.');
    }

    const columnNames = Object.keys(rows[0] ?? {});
    const targetColumn = this.resolveTargetColumn(columnNames, analysis);
    const profile = this.buildDataProfile(rows, columnNames, targetColumn);
    const qualityCheck = this.buildQualityCheck(profile, targetColumn);
    const selectedAddonIds = this.resolveSelectedAddonIds(context);
    const codeSubTasks = this.runCodeBasedSubTasks(selectedAddonIds, rows, columnNames, profile, targetColumn);

    let llmUsed = false;
    let subTaskResults = codeSubTasks;

    if (this.llmClient.isConfigured()) {
      try {
        const llmResults = await this.requestLlmDiagnosis({
          analysis,
          profile,
          qualityCheck,
          selectedAddonIds,
          sampleRows: rows.slice(0, 12),
          fileName: sample.fileName,
        });
        subTaskResults = this.mergeSubTaskResults(codeSubTasks, llmResults.subTaskResults);
        if (llmResults.qualityCheck) {
          Object.assign(qualityCheck, llmResults.qualityCheck);
        }
        llmUsed = true;
      } catch {
        subTaskResults = codeSubTasks;
      }
    }

    const evidence = [
      `[품질] ${qualityCheck.overallVerdict}`,
      `[결측] 최대 결측률 ${profile.maxMissingRatePercent.toFixed(1)}% (${profile.highestMissingColumn || '없음'})`,
      targetColumn
        ? `[불균형] ${targetColumn} 소수 클래스 비율 ${profile.minorityClassRatio === null ? '미확인' : `${(profile.minorityClassRatio * 100).toFixed(1)}%`}`
        : '[불균형] 타깃 컬럼 미지정',
      analysis?.diagnosisSummary ? `[LLM 진단] ${analysis.diagnosisSummary}` : '',
      ...subTaskResults.slice(0, 4).map((item) => `[${item.label}] ${item.summary}`),
    ].filter(Boolean);

    const summary = analysis?.diagnosisSummary?.trim()
      || `데이터 품질·불균형·결측 점검 완료 (${subTaskResults.length}개 세부 작업 실행)`;

    const diagnosisVisuals = this.buildDiagnosisVisuals(profile, targetColumn, columnNames, rows.length);

    return {
      summary,
      inputSummary: `${sample.fileName} · ${rows.length}행 · ${columnNames.length}컬럼`,
      evidence,
      expectedResult: '데이터 품질·불균형·결측 리스크 점검 완료',
      llmUsed: llmUsed || Boolean(analysis?.llmUsed),
      qualityCheck,
      subTaskResults,
      diagnosisVisuals,
      imputationArtifact: null,
      imputationSummary: null,
    };
  }

  async runImputationOnly(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string,
    analysis: DataSourceAnalysisResult | null,
  ): Promise<DiagnosisImputationOnlyResult> {
    if (!dataSourceId?.trim()) {
      throw new BadRequestException('결측 보정에 사용할 데이터 소스가 없습니다.');
    }

    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('보정할 업로드 파일이 없습니다.');
    }

    const rows = this.parseRows(sample.content.toString('utf8'));
    if (!rows.length) {
      throw new BadRequestException('CSV에 보정 가능한 행이 없습니다.');
    }

    const columnNames = Object.keys(rows[0] ?? {});
    const targetColumn = this.resolveTargetColumn(columnNames, analysis);
    const profile = this.buildDataProfile(rows, columnNames, targetColumn);
    const baseVisuals = this.buildDiagnosisVisuals(profile, targetColumn, columnNames, rows.length);

    const totalMissingCells = this.imputationService.countMissingCells(rows, columnNames);
    if (totalMissingCells === 0) {
      return {
        imputationSummary: '결측치가 없어 보정할 항목이 없습니다.',
        imputationArtifact: null,
        diagnosisVisuals: baseVisuals,
        llmUsed: false,
      };
    }

    const imputed = await this.imputationService.imputeMissingValues({
      actorUserId,
      pipelineId,
      fileName: sample.fileName,
      rows,
      columnNames,
      analysis,
    });

    if (!imputed) {
      return {
        imputationSummary: '결측치가 없어 보정할 항목이 없습니다.',
        imputationArtifact: null,
        diagnosisVisuals: baseVisuals,
        llmUsed: false,
      };
    }

    return {
      imputationSummary: imputed.summary,
      imputationArtifact: this.toImputationArtifact(pipelineId, imputed.artifact),
      diagnosisVisuals: {
        ...baseVisuals,
        missingRates: imputed.missingRatesAfter.slice(0, 12),
      },
      llmUsed: imputed.llmUsed,
    };
  }

  private toImputationArtifact(
    pipelineId: string,
    artifact: ImputationArtifactMeta,
  ): DiagnosisImputationArtifact {
    return {
      artifactId: artifact.artifactId,
      fileName: artifact.fileName,
      downloadPath: `/api/v1/pipelines/${pipelineId}/diagnosis/artifacts/${artifact.artifactId}/download`,
      rowCount: artifact.rowCount,
      imputedCellCount: artifact.imputedCellCount,
      remainingMissingCount: artifact.remainingMissingCount,
      columnsImputed: artifact.columnsImputed,
    };
  }

  private buildDiagnosisVisuals(
    profile: ReturnType<PipelineDiagnosisExecutionService['buildDataProfile']>,
    targetColumn: string | null,
    columnNames: string[],
    rowCount: number,
  ): DiagnosisVisuals {
    const missingRates = columnNames
      .map((column) => {
        const missingCount = profile.missingByColumn[column] ?? 0;
        const ratePercent = rowCount > 0 ? (missingCount / rowCount) * 100 : 0;
        return { column, ratePercent, missingCount };
      })
      .sort((a, b) => b.ratePercent - a.ratePercent)
      .slice(0, 12);

    const classDistribution = Object.entries(profile.distribution)
      .map(([label, count]) => ({
        label,
        count,
        ratioPercent: rowCount > 0 ? (count / rowCount) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
      duplicateRows: profile.duplicateRows,
      targetColumn,
      missingRates,
      classDistribution,
    };
  }

  private parseRows(content: string): Record<string, string>[] {
    const parsed = Papa.parse<Record<string, string>>(content, {
      header: true,
      skipEmptyLines: true,
    });
    return (parsed.data ?? []).filter((row) => row && typeof row === 'object');
  }

  private resolveSelectedAddonIds(context: Record<string, unknown> | null): string[] {
    const raw = context?.selectedAddonIds;
    const ids = Array.isArray(raw)
      ? raw.map((item) => String(item).trim()).filter((id) => DIAGNOSIS_ADDON_CATALOG[id])
      : [];
    return ids.length > 0 ? ids : DEFAULT_DIAGNOSIS_ADDON_IDS;
  }

  private resolveTargetColumn(columnNames: string[], analysis: DataSourceAnalysisResult | null): string | null {
    const explicit = analysis?.targetColumn?.trim();
    if (explicit && columnNames.includes(explicit)) return explicit;
    const targetEvent = analysis?.domainForm?.target_event?.trim() ?? '';
    const eqMatch = targetEvent.match(/^([A-Za-z0-9_]+)\s*=/);
    if (eqMatch?.[1] && columnNames.includes(eqMatch[1])) return eqMatch[1];
    const included = columnNames.find((column) => targetEvent.includes(column));
    if (included) return included;
    const heuristic = columnNames.find((column) => /label|target|class|result|outcome|flag/i.test(column));
    return heuristic ?? null;
  }

  private buildDataProfile(
    rows: Record<string, string>[],
    columnNames: string[],
    targetColumn: string | null,
  ) {
    const rowCount = rows.length;
    const missingByColumn: Record<string, number> = {};
    let maxMissingRatePercent = 0;
    let highestMissingColumn = '';

    for (const column of columnNames) {
      const missing = rows.filter((row) => {
        const value = row[column];
        return value === undefined || value === null || String(value).trim() === '';
      }).length;
      missingByColumn[column] = missing;
      const rate = rowCount > 0 ? (missing / rowCount) * 100 : 0;
      if (rate > maxMissingRatePercent) {
        maxMissingRatePercent = rate;
        highestMissingColumn = column;
      }
    }

    const distribution: Record<string, number> = {};
    if (targetColumn) {
      for (const row of rows) {
        const key = String(row[targetColumn] ?? 'UNKNOWN').trim() || 'UNKNOWN';
        distribution[key] = (distribution[key] ?? 0) + 1;
      }
    }
    const sorted = Object.entries(distribution).sort((a, b) => a[1] - b[1]);
    const minorityClassRatio = sorted.length > 0 && rowCount > 0
      ? sorted[0][1] / rowCount
      : null;

    const seen = new Set<string>();
    let duplicateRows = 0;
    for (const row of rows) {
      const key = JSON.stringify(row);
      if (seen.has(key)) duplicateRows += 1;
      else seen.add(key);
    }

    const timeColumn = columnNames.find((column) => /time|date|charttime|timestamp/i.test(column)) ?? null;
    const patientColumn = columnNames.find((column) => /patient|subject|hadm|subject_id/i.test(column)) ?? null;

    return {
      rowCount,
      columnCount: columnNames.length,
      missingByColumn,
      maxMissingRatePercent,
      highestMissingColumn,
      distribution,
      minorityClassRatio,
      duplicateRows,
      timeColumn,
      patientColumn,
    };
  }

  private buildQualityCheck(
    profile: ReturnType<PipelineDiagnosisExecutionService['buildDataProfile']>,
    targetColumn: string | null,
  ): DiagnosisQualityCheck {
    const missingRisk: DiagnosisQualityCheck['missingRisk'] =
      profile.maxMissingRatePercent >= 30 ? 'high'
        : profile.maxMissingRatePercent >= 10 ? 'medium'
          : 'low';

    const minorityRatio = profile.minorityClassRatio;
    const imbalanceRisk: DiagnosisQualityCheck['imbalanceRisk'] =
      minorityRatio === null ? 'medium'
        : minorityRatio < 0.05 ? 'high'
          : minorityRatio < 0.15 ? 'medium'
            : 'low';

    const overallVerdict = [
      `결측 리스크 ${missingRisk}`,
      `불균형 리스크 ${imbalanceRisk}`,
      profile.duplicateRows > 0 ? `중복 행 ${profile.duplicateRows}건` : '중복 행 없음',
    ].join(' · ');

    return {
      missingRisk,
      imbalanceRisk,
      overallVerdict,
      missingRatePercent: profile.maxMissingRatePercent,
      minorityClassRatio: minorityRatio,
      targetColumn,
    };
  }

  private runCodeBasedSubTasks(
    addonIds: string[],
    rows: Record<string, string>[],
    columnNames: string[],
    profile: ReturnType<PipelineDiagnosisExecutionService['buildDataProfile']>,
    targetColumn: string | null,
  ): DiagnosisSubTaskResult[] {
    return addonIds.map((id) => {
      const meta = DIAGNOSIS_ADDON_CATALOG[id];
      if (id === 'addon_dx_anomaly_sparsity_deep') {
        const ratio = profile.minorityClassRatio;
        const summary = ratio === null
          ? '타깃 컬럼을 특정하지 못해 희소성 비율을 계산하지 못했습니다.'
          : `소수 클래스 비율 ${(ratio * 100).toFixed(1)}% — ${ratio < 0.05 ? '희소성 높음' : '보통 수준'}`;
        return {
          id,
          label: meta.label,
          status: 'done',
          summary,
          findings: targetColumn
            ? Object.entries(profile.distribution).map(([label, count]) => `${label}: ${count}건`)
            : ['타깃 컬럼 미지정'],
        };
      }
      if (id === 'addon_dx_timeseries_missing_segments') {
        const timeCol = profile.timeColumn;
        if (!timeCol) {
          return {
            id,
            label: meta.label,
            status: 'done',
            summary: '시간 컬럼을 찾지 못해 구간 분석을 건너뛰었습니다.',
            findings: ['charttime/time 컬럼 없음'],
          };
        }
        const emptyTime = rows.filter((row) => !String(row[timeCol] ?? '').trim()).length;
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `${timeCol} 기준 결측/공백 ${emptyTime}행 (${((emptyTime / rows.length) * 100).toFixed(1)}%)`,
          findings: [`시간 컬럼: ${timeCol}`, `총 ${rows.length}행 중 공백 ${emptyTime}행`],
        };
      }
      if (id === 'addon_dx_leakage_detection') {
        const suspicious = columnNames.filter((column) =>
          /result|outcome|discharge|death|label|target/i.test(column) && column !== targetColumn,
        );
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: suspicious.length
            ? `누수 의심 컬럼 ${suspicious.length}개 검출`
            : '명백한 누수 의심 컬럼은 발견되지 않았습니다.',
          findings: suspicious.length ? suspicious.slice(0, 6) : ['의심 컬럼 없음'],
        };
      }
      if (id === 'addon_dx_class_boundary_overlap') {
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: targetColumn
            ? `${targetColumn} 기준 클래스 ${Object.keys(profile.distribution).length}개 — 경계 중첩은 LLM/추가 통계로 검토 권장`
            : '타깃 컬럼 없음 — 클래스 경계 분석 제한',
          findings: Object.keys(profile.distribution).slice(0, 6),
        };
      }
      if (id === 'addon_dx_patient_level_duplicate') {
        const patientCol = profile.patientColumn;
        if (!patientCol) {
          return {
            id,
            label: meta.label,
            status: 'done',
            summary: '환자 ID 컬럼을 찾지 못했습니다.',
            findings: ['subject_id/patient 컬럼 없음'],
          };
        }
        const counts: Record<string, number> = {};
        for (const row of rows) {
          const key = String(row[patientCol] ?? '').trim();
          if (!key) continue;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const duplicatedPatients = Object.values(counts).filter((count) => count > 1).length;
        return {
          id,
          label: meta.label,
          status: 'done',
          summary: `${patientCol} 기준 중복 환자 ${duplicatedPatients}명`,
          findings: [`전체 환자 키 ${Object.keys(counts).length}개`, `2회 이상 등장 ${duplicatedPatients}명`],
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

  private async requestLlmDiagnosis(input: {
    analysis: DataSourceAnalysisResult | null;
    profile: ReturnType<PipelineDiagnosisExecutionService['buildDataProfile']>;
    qualityCheck: DiagnosisQualityCheck;
    selectedAddonIds: string[];
    sampleRows: Record<string, string>[];
    fileName: string;
  }): Promise<{
    qualityCheck?: Partial<DiagnosisQualityCheck>;
    subTaskResults: DiagnosisSubTaskResult[];
  }> {
    const addonPrompt = input.selectedAddonIds.map((id) => {
      const meta = DIAGNOSIS_ADDON_CATALOG[id];
      return `- ${id}: ${meta?.label ?? id} — ${meta?.description ?? ''}`;
    }).join('\n');

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_diagnosis_execution',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quality_verdict: { type: 'string' },
          missing_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          imbalance_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
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
        required: ['quality_verdict', 'missing_risk', 'imbalance_risk', 'sub_tasks'],
      },
      systemPrompt: [
        'You are a medical ML data quality analyst.',
        'Execute each listed sub-task using the dataset profile and sample rows.',
        'Respond in Korean.',
      ].join(' '),
      userPrompt: [
        `File: ${input.fileName}`,
        `Rows: ${input.profile.rowCount}, Columns: ${input.profile.columnCount}`,
        `Target column: ${input.qualityCheck.targetColumn ?? '(unknown)'}`,
        `Max missing rate: ${input.profile.maxMissingRatePercent.toFixed(1)}%`,
        `Minority ratio: ${input.profile.minorityClassRatio ?? 'unknown'}`,
        `Diagnosis summary: ${input.analysis?.diagnosisSummary ?? ''}`,
        'Sub-tasks to execute:',
        addonPrompt,
        'Sample rows:',
        JSON.stringify(input.sampleRows.slice(0, 8), null, 2),
      ].join('\n'),
    });

    const payload = JSON.parse(raw) as {
      quality_verdict?: string;
      missing_risk?: string;
      imbalance_risk?: string;
      sub_tasks?: Array<{
        addon_id?: string;
        summary?: string;
        findings?: string[];
        status?: string;
      }>;
    };

    const subTaskResults = (payload.sub_tasks ?? [])
      .filter((item) => item?.addon_id && DIAGNOSIS_ADDON_CATALOG[item.addon_id])
      .map((item) => ({
        id: String(item.addon_id),
        label: DIAGNOSIS_ADDON_CATALOG[String(item.addon_id)].label,
        status: item.status === 'failed' ? 'failed' as const : 'done' as const,
        summary: String(item.summary ?? '').trim() || '분석 완료',
        findings: Array.isArray(item.findings) ? item.findings.map(String).filter(Boolean) : [],
      }));

    return {
      qualityCheck: {
        overallVerdict: String(payload.quality_verdict ?? '').trim() || undefined,
        missingRisk: ['low', 'medium', 'high'].includes(String(payload.missing_risk))
          ? payload.missing_risk as DiagnosisQualityCheck['missingRisk']
          : undefined,
        imbalanceRisk: ['low', 'medium', 'high'].includes(String(payload.imbalance_risk))
          ? payload.imbalance_risk as DiagnosisQualityCheck['imbalanceRisk']
          : undefined,
      },
      subTaskResults,
    };
  }

  private mergeSubTaskResults(
    codeResults: DiagnosisSubTaskResult[],
    llmResults: DiagnosisSubTaskResult[],
  ): DiagnosisSubTaskResult[] {
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
