import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { StoreService } from '../store/store.service';

export type DataSourceAnalysisResult = {
  dataSourceId: string;
  fileName: string;
  rowCountEstimate: number | null;
  columnNames: string[];
  domainForm: {
    industry: string;
    subdomain: string;
    data_modality: string;
    row_unit: string;
    ml_task: string;
    target_event: string;
    include_scope: string;
    exclude_scope: string;
  };
  domainIndustryContext: string | null;
  domainSubjectScope: string | null;
  domainRegulationScope: string | null;
  domainStakeholderNotes: string | null;
  rowsLabel: string | null;
  dataModality: string | null;
  rowUnit: string | null;
  diagnosisSummary: string;
  collectionQuery: string;
  llmUsed: boolean;
  targetColumn: string | null;
  targetLabel: string | null;
  previewRows?: Record<string, unknown>[];
};

@Injectable()
export class DataSourceAnalysisService {
  constructor(
    private readonly storeService: StoreService,
    private readonly llmClient: CollectionLlmClientService,
  ) {}

  async analyzeUploadedDataSource(dataSourceId: string): Promise<DataSourceAnalysisResult> {
    const dataSource = await this.storeService.getDataSource(dataSourceId);
    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample) {
      throw new BadRequestException('분석할 업로드 파일이 없습니다. 파일을 포함해 다시 등록해주세요.');
    }

    const parsed = this.parseTabularSample(sample.fileName, sample.content);
    const llmUsed = this.llmClient.isConfigured();
    const llmFields = llmUsed
      ? await this.requestLlmAnalysis(sample.fileName, parsed)
      : this.ruleBasedAnalysis(parsed);

    const targetColumn = dataSource?.targetColumn?.trim() || null;
    const targetLabel = dataSource?.targetLabel?.trim() || null;
    const targetEvent = targetColumn
      ? (targetLabel ? `${targetColumn}=${targetLabel}` : targetColumn)
      : llmFields.target_event;

    return {
      dataSourceId,
      fileName: sample.fileName,
      rowCountEstimate: parsed.rowCountEstimate,
      columnNames: parsed.columnNames,
      domainForm: {
        industry: llmFields.industry,
        subdomain: llmFields.subdomain,
        data_modality: llmFields.data_modality,
        row_unit: llmFields.row_unit,
        ml_task: llmFields.ml_task,
        target_event: targetEvent,
        include_scope: llmFields.include_scope,
        exclude_scope: llmFields.exclude_scope,
      },
      domainIndustryContext: llmFields.industry || null,
      domainSubjectScope: llmFields.include_scope || null,
      domainRegulationScope: llmFields.exclude_scope || null,
      domainStakeholderNotes: llmFields.diagnosis_summary || null,
      rowsLabel: llmFields.rows_label,
      dataModality: llmFields.data_modality || null,
      rowUnit: llmFields.row_unit || null,
      diagnosisSummary: llmFields.diagnosis_summary,
      collectionQuery: llmFields.collection_query,
      llmUsed,
      targetColumn,
      targetLabel,
      previewRows: parsed.previewRows,
    };
  }

  async previewUploadedDataSource(dataSourceId: string): Promise<{
    dataSourceId: string;
    fileName: string;
    rowCountEstimate: number | null;
    columnNames: string[];
    previewRows: Record<string, unknown>[];
  }> {
    const sample = await this.storeService.getPrimaryDataSourceFileContent(dataSourceId);
    if (!sample) {
      throw new BadRequestException('미리볼 업로드 파일이 없습니다. 파일을 포함해 다시 등록해주세요.');
    }
    const parsed = this.parseTabularSample(sample.fileName, sample.content);
    return {
      dataSourceId,
      fileName: parsed.fileName,
      rowCountEstimate: parsed.rowCountEstimate,
      columnNames: parsed.columnNames,
      previewRows: parsed.previewRows,
    };
  }

  private parseTabularSample(fileName: string, content: Buffer): {
    fileName: string;
    rowCountEstimate: number | null;
    columnNames: string[];
    previewRows: Record<string, unknown>[];
    previewText: string;
  } {
    const text = content.toString('utf8');
    const ext = fileName.toLowerCase();
    if (ext.endsWith('.json') || ext.endsWith('.jsonl')) {
      return this.parseJsonSample(fileName, text);
    }
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      preview: 40,
    });
    const rows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    const columnNames = parsed.meta.fields?.filter(Boolean) ?? Object.keys(rows[0] ?? {});
    return {
      fileName,
      rowCountEstimate: rows.length > 0 ? rows.length : null,
      columnNames,
      previewRows: rows.slice(0, 20),
      previewText: JSON.stringify(rows.slice(0, 8), null, 2),
    };
  }

  private parseJsonSample(fileName: string, text: string) {
    let rows: Record<string, unknown>[] = [];
    if (fileName.endsWith('.jsonl')) {
      rows = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 40)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } else {
      const payload = JSON.parse(text) as unknown;
      if (Array.isArray(payload)) {
        rows = payload.slice(0, 40).filter((item) => item && typeof item === 'object') as Record<string, unknown>[];
      } else if (payload && typeof payload === 'object') {
        rows = [payload as Record<string, unknown>];
      }
    }
    const columnNames = rows.length ? Object.keys(rows[0]) : [];
    return {
      fileName,
      rowCountEstimate: rows.length || null,
      columnNames,
      previewRows: rows.slice(0, 20),
      previewText: JSON.stringify(rows.slice(0, 8), null, 2),
    };
  }

  private async requestLlmAnalysis(
    fileName: string,
    parsed: {
      columnNames: string[];
      rowCountEstimate: number | null;
      previewText: string;
    },
  ) {
    const raw = await this.llmClient.requestJson({
      schemaName: 'data_source_upload_analysis',
      schema: {
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
          rows_label: { type: 'string' },
          diagnosis_summary: { type: 'string' },
          collection_query: { type: 'string' },
        },
        required: [
          'industry',
          'subdomain',
          'data_modality',
          'row_unit',
          'ml_task',
          'target_event',
          'include_scope',
          'exclude_scope',
          'rows_label',
          'diagnosis_summary',
          'collection_query',
        ],
      },
      systemPrompt: [
        'You analyze uploaded tabular datasets for an ML workbench.',
        'Respond in Korean for human-readable text fields.',
        'Infer realistic domain context, ML task, target column/event, and a concise external dataset search query.',
      ].join(' '),
      userPrompt: [
        `File: ${fileName}`,
        `Columns: ${parsed.columnNames.join(', ') || '(unknown)'}`,
        `Sample row count in preview: ${parsed.rowCountEstimate ?? 'unknown'}`,
        'Sample rows:',
        parsed.previewText,
      ].join('\n'),
    });

    return this.normalizeLlmFields(raw, parsed);
  }

  private ruleBasedAnalysis(parsed: {
    columnNames: string[];
    rowCountEstimate: number | null;
  }) {
    const cols = parsed.columnNames;
    const target = cols.find((c) => /label|target|class|outcome|event|flag/i.test(c)) ?? cols[cols.length - 1] ?? 'target';
    return {
      industry: '일반',
      subdomain: '업로드 데이터 분석',
      data_modality: '테이블',
      row_unit: '행 단위',
      ml_task: '분류 또는 이상탐지',
      target_event: target,
      include_scope: cols.slice(0, 8).join(', '),
      exclude_scope: '',
      rows_label: parsed.rowCountEstimate ? `약 ${parsed.rowCountEstimate}행 (샘플 기준)` : null,
      diagnosis_summary: `LLM 미연결 상태입니다. 컬럼 ${cols.length}개를 기준으로 기본 초안을 생성했습니다.`,
      collection_query: `${cols.slice(0, 5).join(' ')} tabular dataset`,
    };
  }

  private normalizeLlmFields(
    raw: string,
    parsed: { rowCountEstimate: number | null },
  ) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.ruleBasedAnalysis({
        columnNames: [],
        rowCountEstimate: parsed.rowCountEstimate,
      });
    }
    const text = (key: string) => (typeof payload[key] === 'string' ? String(payload[key]).trim() : '');
    return {
      industry: text('industry') || '일반',
      subdomain: text('subdomain') || '업로드 데이터',
      data_modality: text('data_modality') || '테이블',
      row_unit: text('row_unit') || '행 단위',
      ml_task: text('ml_task') || '미정',
      target_event: text('target_event') || '미정',
      include_scope: text('include_scope'),
      exclude_scope: text('exclude_scope'),
      rows_label: text('rows_label') || (parsed.rowCountEstimate ? `약 ${parsed.rowCountEstimate}행 (샘플)` : null),
      diagnosis_summary: text('diagnosis_summary') || 'LLM 분석이 완료되었습니다.',
      collection_query: text('collection_query') || `${text('industry')} ${text('subdomain')} dataset`,
    };
  }
}
