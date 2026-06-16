import { Injectable } from '@nestjs/common';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { DataSourceAnalysisService } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { PipelineSynthesisService, type PipelineStepSynthesisVisuals } from './pipeline-synthesis.service';
import { PipelineDiagnosisExecutionService } from './pipeline-diagnosis-execution.service';
import {
  PipelineDomainExecutionService,
  type PipelineStepDomainVisuals,
} from './pipeline-domain-execution.service';
import {
  PipelineMatchingExecutionService,
  type PipelineStepMatchingVisuals,
  type MatchingReviewSnapshot,
} from './pipeline-matching-execution.service';
import type { MergeArtifactMeta, MergeVisuals } from './pipeline-data-merge.service';
import {
  PipelineResultsExecutionService,
  type PipelineStepResultsVisuals,
} from './pipeline-results-execution.service';

export type PipelineSynthesisArtifact = {
  artifactId: string;
  fileName: string;
  downloadPath: string;
  originalRowCount: number;
  syntheticRowCount: number;
  totalRowCount: number;
  targetColumn: string;
  minorityLabel: string;
  mode: string;
};

export type PipelineStepSubTaskResult = {
  id: string;
  label: string;
  status: 'done' | 'failed';
  summary: string;
  findings: string[];
};

export type PipelineStepQualityCheck = {
  missingRisk: 'low' | 'medium' | 'high';
  imbalanceRisk: 'low' | 'medium' | 'high';
  overallVerdict: string;
  missingRatePercent?: number;
  minorityClassRatio?: number | null;
  targetColumn?: string | null;
};

export type PipelineStepDiagnosisVisuals = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  targetColumn: string | null;
  missingRates: Array<{ column: string; ratePercent: number; missingCount: number }>;
  classDistribution: Array<{ label: string; count: number; ratioPercent: number }>;
};

export type PipelineStepImputationArtifact = {
  artifactId: string;
  fileName: string;
  downloadPath: string;
  rowCount: number;
  imputedCellCount: number;
  remainingMissingCount: number;
  columnsImputed: string[];
};

export type PipelineStepExecutionResult = {
  stepId: string;
  summary: string;
  inputSummary: string;
  evidence: string[];
  expectedResult: string;
  llmUsed: boolean;
  synthesisArtifact?: PipelineSynthesisArtifact | null;
  subTaskResults?: PipelineStepSubTaskResult[];
  qualityCheck?: PipelineStepQualityCheck | null;
  diagnosisVisuals?: PipelineStepDiagnosisVisuals | null;
  domainVisuals?: PipelineStepDomainVisuals | null;
  domainForm?: PipelineStepDomainVisuals['domainForm'] | null;
  matchingVisuals?: PipelineStepMatchingVisuals | null;
  matchingReview?: MatchingReviewSnapshot | null;
  mergeArtifact?: MergeArtifactMeta | null;
  mergeVisuals?: MergeVisuals | null;
  synthesisVisuals?: PipelineStepSynthesisVisuals | null;
  imputationArtifact?: PipelineStepImputationArtifact | null;
  imputationSummary?: string | null;
  synthesisPlan?: import('./pipeline-synthesis.service').SynthesisPlanSnapshot | null;
  synthesisProgress?: import('./pipeline-synthesis.service').SynthesisProgress | null;
  resultsVisuals?: PipelineStepResultsVisuals | null;
};

const CORE_STEPS = new Set(['diagnosis', 'domain', 'search', 'matching', 'synthesis', 'results']);

@Injectable()
export class PipelineStepExecutionService {
  constructor(
    private readonly analysisService: DataSourceAnalysisService,
    private readonly dataSourcesService: DataSourcesService,
    private readonly llmClient: CollectionLlmClientService,
    private readonly synthesisService: PipelineSynthesisService,
    private readonly diagnosisService: PipelineDiagnosisExecutionService,
    private readonly domainService: PipelineDomainExecutionService,
    private readonly matchingService: PipelineMatchingExecutionService,
    private readonly resultsService: PipelineResultsExecutionService,
  ) {}

  async executeStep(
    actorUserId: string,
    input: {
      pipelineId: string;
      stepId: string;
      dataSourceId?: string | null;
      analysis?: Partial<DataSourceAnalysisResult> | null;
      context?: Record<string, unknown> | null;
    },
  ): Promise<PipelineStepExecutionResult> {
    const stepId = this.normalizeStepId(input.stepId);
    if (!CORE_STEPS.has(stepId)) {
      throw new Error(`Unsupported pipeline step: ${input.stepId}`);
    }

    let analysis = this.normalizeAnalysis(input.analysis ?? null);
    if (input.dataSourceId?.trim()) {
      await this.dataSourcesService.get(input.dataSourceId.trim(), actorUserId);
      if (!analysis?.diagnosisSummary?.trim() || (analysis.columnNames?.length ?? 0) === 0) {
        try {
          analysis = this.normalizeAnalysis(
            await this.analysisService.analyzeUploadedDataSource(input.dataSourceId.trim()),
          );
        } catch {
          analysis = analysis ?? null;
        }
      }
    }

    if (stepId === 'diagnosis' && input.dataSourceId?.trim()) {
      return this.executeDiagnosisStep(
        actorUserId,
        input.pipelineId,
        input.dataSourceId.trim(),
        analysis,
        input.context ?? null,
      );
    }

    if (stepId === 'domain' && input.dataSourceId?.trim()) {
      return this.executeDomainStep(
        actorUserId,
        input.pipelineId,
        input.dataSourceId.trim(),
        analysis,
        input.context ?? null,
      );
    }

    if (stepId === 'domain') {
      return this.fromAnalysis(stepId, analysis);
    }

    if (stepId === 'matching') {
      return this.executeMatchingStep(
        actorUserId,
        input.pipelineId,
        input.dataSourceId?.trim() ?? null,
        analysis,
        input.context ?? null,
      );
    }

    if (stepId === 'synthesis') {
      return this.executeSynthesisStep(actorUserId, input.pipelineId, {
        dataSourceId: input.dataSourceId ?? null,
        analysis,
        context: input.context ?? null,
      });
    }

    if (stepId === 'results') {
      return this.executeResultsStep(
        actorUserId,
        input.pipelineId,
        input.dataSourceId?.trim() ?? null,
        analysis,
        input.context ?? null,
      );
    }

    if (this.llmClient.isConfigured() && analysis) {
      try {
        return await this.requestLlmStep(stepId, analysis, input.context ?? {});
      } catch {
        return this.fallbackStep(stepId, analysis, input.context ?? {});
      }
    }

    return this.fallbackStep(stepId, analysis, input.context ?? {});
  }

  private normalizeStepId(stepId: string): string {
    const raw = stepId.trim().toLowerCase();
    const alias: Record<string, string> = {
      collection: 'diagnosis',
      define: 'domain',
      discovery: 'search',
      discover: 'search',
      match: 'matching',
      synth: 'synthesis',
      result: 'results',
      compare: 'results',
    };
    return alias[raw] || raw;
  }

  private normalizeAnalysis(
    analysis: Partial<DataSourceAnalysisResult> | null,
  ): DataSourceAnalysisResult | null {
    if (!analysis) return null;
    return {
      dataSourceId: analysis.dataSourceId ?? '',
      fileName: analysis.fileName ?? '(unknown)',
      rowCountEstimate: analysis.rowCountEstimate ?? null,
      columnNames: Array.isArray(analysis.columnNames) ? analysis.columnNames : [],
      domainForm: {
        industry: analysis.domainForm?.industry ?? '',
        subdomain: analysis.domainForm?.subdomain ?? '',
        data_modality: analysis.domainForm?.data_modality ?? '',
        row_unit: analysis.domainForm?.row_unit ?? '',
        ml_task: analysis.domainForm?.ml_task ?? '',
        target_event: analysis.domainForm?.target_event ?? '',
        include_scope: analysis.domainForm?.include_scope ?? '',
        exclude_scope: analysis.domainForm?.exclude_scope ?? '',
      },
      domainIndustryContext: analysis.domainIndustryContext ?? null,
      domainSubjectScope: analysis.domainSubjectScope ?? null,
      domainRegulationScope: analysis.domainRegulationScope ?? null,
      domainStakeholderNotes: analysis.domainStakeholderNotes ?? null,
      rowsLabel: analysis.rowsLabel ?? null,
      dataModality: analysis.dataModality ?? null,
      rowUnit: analysis.rowUnit ?? null,
      diagnosisSummary: analysis.diagnosisSummary ?? '',
      collectionQuery: analysis.collectionQuery ?? '',
      llmUsed: Boolean(analysis.llmUsed),
      targetColumn: analysis.targetColumn ?? null,
      targetLabel: analysis.targetLabel ?? null,
    };
  }

  private fromAnalysis(stepId: string, analysis: DataSourceAnalysisResult | null): PipelineStepExecutionResult {
    const columns = analysis?.columnNames ?? [];
    const form = analysis?.domainForm;
    if (stepId === 'diagnosis') {
      return {
        stepId,
        summary: analysis?.diagnosisSummary || '데이터 진단이 완료되었습니다.',
        inputSummary: `${analysis?.fileName || '데이터셋'} · ${analysis?.rowCountEstimate ?? '?'}행 · ${columns.length}컬럼`,
        evidence: [
          analysis?.diagnosisSummary || 'LLM 진단 요약',
          columns.length ? `컬럼: ${columns.slice(0, 6).join(', ')}` : '컬럼 정보 없음',
        ],
        expectedResult: '데이터 품질·불균형·결측 리스크 점검 완료',
        llmUsed: Boolean(analysis?.llmUsed),
      };
    }
    return {
      stepId,
      summary: '도메인 정의 초안이 생성되었습니다.',
      inputSummary: `${form?.industry || '도메인'} · ${form?.ml_task || 'ML task'} · ${form?.data_modality || 'modality'}`,
      evidence: [
        form?.target_event ? `타깃: ${form.target_event}` : '',
        form?.include_scope ? `포함: ${form.include_scope}` : '',
        form?.exclude_scope ? `제외: ${form.exclude_scope}` : '',
      ].filter(Boolean),
      expectedResult: '도메인·태스크·스코프 초안 확정',
      llmUsed: Boolean(analysis?.llmUsed),
    };
  }

  private async requestLlmStep(
    stepId: string,
    analysis: DataSourceAnalysisResult,
    context: Record<string, unknown>,
  ): Promise<PipelineStepExecutionResult> {
    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_step_execution',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          input_summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          expected_result: { type: 'string' },
        },
        required: ['summary', 'input_summary', 'evidence', 'expected_result'],
      },
      systemPrompt: [
        'You execute one step of an ML data pipeline workbench.',
        'Respond in Korean.',
        'Base outputs on the dataset analysis and step goal.',
      ].join(' '),
      userPrompt: [
        `Step: ${stepId}`,
        `File: ${analysis.fileName}`,
        `Columns: ${(analysis.columnNames ?? []).join(', ') || '(unknown)'}`,
        `Diagnosis: ${analysis.diagnosisSummary}`,
        `Industry: ${analysis.domainForm.industry}`,
        `ML task: ${analysis.domainForm.ml_task}`,
        `Context: ${JSON.stringify(context).slice(0, 2000)}`,
      ].join('\n'),
    });

    const payload = JSON.parse(raw) as {
      summary?: string;
      input_summary?: string;
      evidence?: string[];
      expected_result?: string;
    };

    return {
      stepId,
      summary: String(payload.summary ?? '').trim() || `${stepId} 단계 실행 완료`,
      inputSummary: String(payload.input_summary ?? '').trim() || analysis.fileName,
      evidence: Array.isArray(payload.evidence) ? payload.evidence.map(String).filter(Boolean) : [],
      expectedResult: String(payload.expected_result ?? '').trim() || '결과 검토 필요',
      llmUsed: true,
    };
  }

  private async executeMatchingStep(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string | null,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<PipelineStepExecutionResult> {
    const result = await this.matchingService.execute(
      actorUserId,
      pipelineId,
      dataSourceId,
      analysis,
      context,
    );
    return {
      stepId: 'matching',
      summary: result.summary,
      inputSummary: result.inputSummary,
      evidence: result.evidence,
      expectedResult: result.expectedResult,
      llmUsed: result.llmUsed,
      subTaskResults: result.subTaskResults,
      matchingVisuals: result.matchingVisuals,
      matchingReview: result.matchingReview,
      mergeArtifact: result.mergeArtifact ?? null,
      mergeVisuals: result.mergeVisuals ?? null,
    };
  }

  private async executeDomainStep(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<PipelineStepExecutionResult> {
    const result = await this.domainService.execute(
      actorUserId,
      pipelineId,
      dataSourceId,
      analysis,
      context,
    );
    return {
      stepId: 'domain',
      summary: result.summary,
      inputSummary: result.inputSummary,
      evidence: result.evidence,
      expectedResult: result.expectedResult,
      llmUsed: result.llmUsed,
      subTaskResults: result.subTaskResults,
      domainVisuals: result.domainVisuals,
      domainForm: result.domainForm,
    };
  }

  private async executeDiagnosisStep(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<PipelineStepExecutionResult> {
    const result = await this.diagnosisService.execute(
      actorUserId,
      pipelineId,
      dataSourceId,
      analysis,
      context,
    );
    return {
      stepId: 'diagnosis',
      summary: result.summary,
      inputSummary: result.inputSummary,
      evidence: result.evidence,
      expectedResult: result.expectedResult,
      llmUsed: result.llmUsed,
      qualityCheck: result.qualityCheck,
      subTaskResults: result.subTaskResults,
      diagnosisVisuals: result.diagnosisVisuals,
      imputationArtifact: result.imputationArtifact ?? null,
      imputationSummary: result.imputationSummary ?? null,
    };
  }

  private async executeResultsStep(
    actorUserId: string,
    pipelineId: string,
    dataSourceId: string | null,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown> | null,
  ): Promise<PipelineStepExecutionResult> {
    const result = await this.resultsService.execute(
      actorUserId,
      pipelineId,
      dataSourceId,
      analysis,
      context,
    );
    return {
      stepId: 'results',
      summary: result.summary,
      inputSummary: result.inputSummary,
      evidence: result.evidence,
      expectedResult: result.expectedResult,
      llmUsed: result.llmUsed,
      subTaskResults: result.subTaskResults,
      resultsVisuals: result.resultsVisuals,
    };
  }

  private async executeSynthesisStep(
    actorUserId: string,
    pipelineId: string,
    input: {
      dataSourceId?: string | null;
      analysis: DataSourceAnalysisResult | null;
      context: Record<string, unknown> | null;
    },
  ): Promise<PipelineStepExecutionResult> {
    const generated = await this.synthesisService.generateSyntheticDataset(actorUserId, pipelineId, input);
    const artifact = generated.artifact ?? null;
    return {
      stepId: 'synthesis',
      summary: generated.summary,
      inputSummary: generated.inputSummary,
      evidence: generated.evidence,
      expectedResult: generated.expectedResult,
      llmUsed: generated.llmUsed,
      subTaskResults: generated.subTaskResults,
      synthesisVisuals: generated.synthesisVisuals,
      synthesisPlan: generated.synthesisPlan ?? null,
      synthesisProgress: generated.synthesisProgress ?? null,
      synthesisArtifact: artifact
        ? {
            artifactId: artifact.artifactId,
            fileName: artifact.fileName,
            downloadPath: `/api/v1/pipelines/${pipelineId}/synthesis/artifacts/${artifact.artifactId}/download`,
            originalRowCount: artifact.originalRowCount,
            syntheticRowCount: artifact.syntheticRowCount,
            totalRowCount: artifact.totalRowCount,
            targetColumn: artifact.targetColumn,
            minorityLabel: artifact.minorityLabel,
            mode: artifact.mode,
          }
        : null,
    };
  }

  private fallbackStep(
    stepId: string,
    analysis: DataSourceAnalysisResult | null,
    context: Record<string, unknown>,
  ): PipelineStepExecutionResult {
    const labels: Record<string, string> = {
      search: '외부 데이터 탐색',
      matching: '정합성 검토',
      synthesis: '합성 데이터 설계',
      results: '결과 비교',
    };
    const contextSummary = typeof context.summary === 'string' ? context.summary : '';
    const diagnosis = analysis?.diagnosisSummary || '';
    return {
      stepId,
      summary: contextSummary || `${labels[stepId] || stepId} 단계가 완료되었습니다.`,
      inputSummary: `${analysis?.fileName || '데이터셋'} · ${analysis?.domainForm?.ml_task || 'ML task'}`,
      evidence: [diagnosis, contextSummary].filter(Boolean),
      expectedResult: '실행 결과를 검토하고 다음 단계로 진행하세요.',
      llmUsed: false,
    };
  }
}
