import { Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';

export type ImputationArtifactMeta = {
  artifactId: string;
  pipelineId: string;
  userId: string;
  fileName: string;
  filePath: string;
  rowCount: number;
  imputedCellCount: number;
  remainingMissingCount: number;
  columnsImputed: string[];
  createdAt: string;
};

export type ImputationResult = {
  summary: string;
  rows: Record<string, string>[];
  artifact: ImputationArtifactMeta;
  imputedCellCount: number;
  remainingMissingCount: number;
  columnsImputed: string[];
  llmUsed: boolean;
  missingRatesAfter: Array<{ column: string; ratePercent: number; missingCount: number }>;
};

const BATCH_SIZE = 8;
const MAX_BATCHES = 80;
const FULL_COLUMN_BATCH_SIZE = 12;

@Injectable()
export class PipelineMissingImputationService {
  private readonly artifactDir = (
    process.env.IMPUTATION_ARTIFACT_DIR?.trim() || join(process.cwd(), 'storage', 'imputation-artifacts')
  );
  private readonly artifacts = new Map<string, ImputationArtifactMeta>();

  constructor(private readonly llmClient: CollectionLlmClientService) {}

  async getArtifact(
    pipelineId: string,
    artifactId: string,
    actorUserId: string,
  ): Promise<ImputationArtifactMeta> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.pipelineId !== pipelineId || artifact.userId !== actorUserId) {
      throw new NotFoundException('결측 보정 파일을 찾을 수 없습니다.');
    }
    return artifact;
  }

  async readArtifactContent(artifact: ImputationArtifactMeta): Promise<Buffer> {
    return readFile(artifact.filePath);
  }

  countMissingCells(rows: Record<string, string>[], columnNames: string[]): number {
    let count = 0;
    for (const row of rows) {
      for (const column of columnNames) {
        if (this.isMissing(row[column])) count += 1;
      }
    }
    return count;
  }

  computeMissingRates(rows: Record<string, string>[], columnNames: string[]) {
    const rowCount = rows.length;
    return columnNames
      .map((column) => {
        const missingCount = rows.filter((row) => this.isMissing(row[column])).length;
        return {
          column,
          missingCount,
          ratePercent: rowCount > 0 ? (missingCount / rowCount) * 100 : 0,
        };
      })
      .sort((a, b) => b.ratePercent - a.ratePercent);
  }

  async imputeMissingValues(input: {
    actorUserId: string;
    pipelineId: string;
    fileName: string;
    rows: Record<string, string>[];
    columnNames: string[];
    analysis: DataSourceAnalysisResult | null;
  }): Promise<ImputationResult | null> {
    const { rows, columnNames } = input;
    const beforeMissing = this.countMissingCells(rows, columnNames);
    if (beforeMissing === 0) return null;

    const missingRates = this.computeMissingRates(rows, columnNames);
    const columnsToImpute = missingRates
      .filter((item) => item.missingCount > 0)
      .map((item) => item.column);

    const imputedRows = rows.map((row) => ({ ...row }));
    const columnStats = this.buildColumnStats(imputedRows, columnNames);
    let imputedCellCount = 0;
    let llmUsed = false;

    const targets = imputedRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => columnsToImpute.some((column) => this.isMissing(row[column])));

    let batchCount = 0;
    for (let offset = 0; offset < targets.length && batchCount < MAX_BATCHES; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      batchCount += 1;
      let batchImputed = 0;

      if (this.llmClient.isConfigured()) {
        try {
          batchImputed = await this.imputeBatchWithLlm({
            batch,
            columnNames,
            columnsToImpute,
            columnStats,
            analysis: input.analysis,
            imputedRows,
          });
          if (batchImputed > 0) llmUsed = true;
        } catch {
          batchImputed = 0;
        }
      }

      if (batchImputed === 0) {
        batchImputed = this.imputeBatchStatistical(batch, columnsToImpute, columnStats, imputedRows);
      }
      imputedCellCount += batchImputed;
    }

    const fullColumnResult = await this.imputeFullyMissingColumns({
      imputedRows,
      columnNames,
      columnsToImpute,
      columnStats,
      analysis: input.analysis,
    });
    imputedCellCount += fullColumnResult.imputedCellCount;
    if (fullColumnResult.llmUsed) llmUsed = true;

    const remainingMissingCount = this.countMissingCells(imputedRows, columnNames);
    const missingRatesAfter = this.computeMissingRates(imputedRows, columnNames);
    const baseName = input.fileName.replace(/\.[^.]+$/, '') || 'dataset';
    const fileName = `${baseName}_imputed.csv`;
    const csvContent = Papa.unparse(imputedRows, { columns: columnNames });
    await mkdir(this.artifactDir, { recursive: true });
    const artifactId = `imp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const filePath = join(this.artifactDir, `${artifactId}.csv`);
    await writeFile(filePath, csvContent, 'utf8');

    const artifact: ImputationArtifactMeta = {
      artifactId,
      pipelineId: input.pipelineId,
      userId: input.actorUserId,
      fileName,
      filePath,
      rowCount: imputedRows.length,
      imputedCellCount,
      remainingMissingCount,
      columnsImputed: columnsToImpute,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(artifactId, artifact);

    const summary = llmUsed
      ? `LLM 결측 보정 완료: ${imputedCellCount}개 셀 채움 (잔여 결측 ${remainingMissingCount}개)`
      : `통계 기반 결측 보정 완료: ${imputedCellCount}개 셀 채움 (잔여 결측 ${remainingMissingCount}개)`;

    return {
      summary,
      rows: imputedRows,
      artifact,
      imputedCellCount,
      remainingMissingCount,
      columnsImputed: columnsToImpute,
      llmUsed,
      missingRatesAfter,
    };
  }

  private isMissing(value: unknown): boolean {
    return value === undefined || value === null || String(value).trim() === '';
  }

  private buildColumnStats(rows: Record<string, string>[], columnNames: string[]) {
    const stats: Record<string, {
      type: 'numeric' | 'categorical';
      mean?: number;
      median?: number;
      mode?: string;
      samples: string[];
    }> = {};

    for (const column of columnNames) {
      const values = rows
        .map((row) => row[column])
        .filter((value) => !this.isMissing(value))
        .map(String);
      const numeric = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      if (numeric.length >= Math.max(3, values.length * 0.6)) {
        const sorted = [...numeric].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
        stats[column] = { type: 'numeric', mean, median: mid, samples: values.slice(0, 5) };
      } else {
        const counts: Record<string, number> = {};
        for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
        const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
        stats[column] = { type: 'categorical', mode, samples: values.slice(0, 5) };
      }
    }
    return stats;
  }

  private imputeBatchStatistical(
    batch: Array<{ row: Record<string, string>; index: number }>,
    columnsToImpute: string[],
    columnStats: ReturnType<PipelineMissingImputationService['buildColumnStats']>,
    imputedRows: Record<string, string>[],
  ): number {
    let count = 0;
    for (const { row, index } of batch) {
      for (const column of columnsToImpute) {
        if (!this.isMissing(row[column])) continue;
        const stat = columnStats[column];
        if (!stat) {
          imputedRows[index][column] = this.defaultImputationValue(column);
          count += 1;
          continue;
        }
        if (stat.type === 'numeric') {
          imputedRows[index][column] = String(stat.median ?? stat.mean ?? 0);
        } else {
          imputedRows[index][column] = stat.mode || this.defaultImputationValue(column);
        }
        count += 1;
      }
    }
    return count;
  }

  private async imputeBatchWithLlm(input: {
    batch: Array<{ row: Record<string, string>; index: number }>;
    columnNames: string[];
    columnsToImpute: string[];
    columnStats: ReturnType<PipelineMissingImputationService['buildColumnStats']>;
    analysis: DataSourceAnalysisResult | null;
    imputedRows: Record<string, string>[];
  }): Promise<number> {
    const payloadRows = input.batch.map(({ row, index }) => ({
      row_index: index,
      current: Object.fromEntries(
        input.columnNames.map((column) => [column, this.isMissing(row[column]) ? null : String(row[column])]),
      ),
      missing_columns: input.columnsToImpute.filter((column) => this.isMissing(row[column])),
    }));

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_missing_imputation',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imputed_rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                row_index: { type: 'number' },
                values: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['row_index', 'values'],
            },
          },
          notes: { type: 'string' },
        },
        required: ['imputed_rows', 'notes'],
      },
      systemPrompt: [
        'You impute missing tabular values for a medical ML dataset.',
        'Fill only the missing columns listed for each row.',
        'Keep values clinically plausible and consistent with other columns in the same row.',
        'Respond in JSON only. Use string values for all imputed cells.',
      ].join(' '),
      userPrompt: [
        `Industry: ${input.analysis?.domainForm?.industry ?? ''}`,
        `ML task: ${input.analysis?.domainForm?.ml_task ?? ''}`,
        `Target: ${input.analysis?.domainForm?.target_event ?? ''}`,
        `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
        'Column stats:',
        JSON.stringify(
          Object.fromEntries(
            input.columnsToImpute.map((column) => [column, input.columnStats[column] ?? {}]),
          ),
          null,
          2,
        ),
        'Rows to impute:',
        JSON.stringify(payloadRows, null, 2),
      ].join('\n'),
    });

    const parsed = JSON.parse(raw) as {
      imputed_rows?: Array<{ row_index?: number; values?: Record<string, string> }>;
    };

    let count = 0;
    for (const item of parsed.imputed_rows ?? []) {
      const rowIndex = item.row_index;
      if (typeof rowIndex !== 'number' || !item.values) continue;
      for (const [column, value] of Object.entries(item.values)) {
        if (!input.columnsToImpute.includes(column)) continue;
        if (this.isMissing(input.imputedRows[rowIndex]?.[column])) {
          input.imputedRows[rowIndex][column] = String(value);
          count += 1;
        }
      }
    }
    return count;
  }

  private defaultImputationValue(column: string): string {
    const name = column.toLowerCase();
    if (/date|time|_dt$|_at$/.test(name)) return '1900-01-01';
    if (/culture|pcr|rat|result|test|specimen/.test(name)) return 'not_collected';
    if (/flag|status|type/.test(name)) return 'unknown';
    return 'unknown';
  }

  private async imputeFullyMissingColumns(input: {
    imputedRows: Record<string, string>[];
    columnNames: string[];
    columnsToImpute: string[];
    columnStats: ReturnType<PipelineMissingImputationService['buildColumnStats']>;
    analysis: DataSourceAnalysisResult | null;
  }): Promise<{ imputedCellCount: number; llmUsed: boolean }> {
    let imputedCellCount = 0;
    let llmUsed = false;

    for (const column of input.columnsToImpute) {
      const missingIndices = input.imputedRows
        .map((row, index) => (this.isMissing(row[column]) ? index : -1))
        .filter((index) => index >= 0);
      if (missingIndices.length !== input.imputedRows.length) continue;

      for (let offset = 0; offset < missingIndices.length; offset += FULL_COLUMN_BATCH_SIZE) {
        const batchIndices = missingIndices.slice(offset, offset + FULL_COLUMN_BATCH_SIZE);
        let batchImputed = 0;

        if (this.llmClient.isConfigured()) {
          try {
            batchImputed = await this.imputeFullColumnBatchWithLlm({
              column,
              batchIndices,
              columnNames: input.columnNames,
              imputedRows: input.imputedRows,
              analysis: input.analysis,
            });
            if (batchImputed > 0) llmUsed = true;
          } catch {
            batchImputed = 0;
          }
        }

        if (batchImputed === 0) {
          const defaultValue = this.defaultImputationValue(column);
          for (const index of batchIndices) {
            if (this.isMissing(input.imputedRows[index][column])) {
              input.imputedRows[index][column] = defaultValue;
              batchImputed += 1;
            }
          }
        }
        imputedCellCount += batchImputed;
      }
    }

    return { imputedCellCount, llmUsed };
  }

  private async imputeFullColumnBatchWithLlm(input: {
    column: string;
    batchIndices: number[];
    columnNames: string[];
    imputedRows: Record<string, string>[];
    analysis: DataSourceAnalysisResult | null;
  }): Promise<number> {
    const payloadRows = input.batchIndices.map((index) => ({
      row_index: index,
      current: Object.fromEntries(
        input.columnNames.map((col) => [
          col,
          this.isMissing(input.imputedRows[index][col]) ? null : String(input.imputedRows[index][col]),
        ]),
      ),
    }));

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_full_column_imputation',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imputed_rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                row_index: { type: 'number' },
                value: { type: 'string' },
              },
              required: ['row_index', 'value'],
            },
          },
          notes: { type: 'string' },
        },
        required: ['imputed_rows', 'notes'],
      },
      systemPrompt: [
        'You impute a single fully-missing column in a medical ML dataset.',
        'Use other columns in each row to infer plausible values.',
        'Respond in JSON only. Use string values.',
      ].join(' '),
      userPrompt: [
        `Column to impute: ${input.column}`,
        `Industry: ${input.analysis?.domainForm?.industry ?? ''}`,
        `ML task: ${input.analysis?.domainForm?.ml_task ?? ''}`,
        `Target: ${input.analysis?.domainForm?.target_event ?? ''}`,
        `Diagnosis: ${input.analysis?.diagnosisSummary ?? ''}`,
        'Rows:',
        JSON.stringify(payloadRows, null, 2),
      ].join('\n'),
    });

    const parsed = JSON.parse(raw) as {
      imputed_rows?: Array<{ row_index?: number; value?: string }>;
    };

    let count = 0;
    for (const item of parsed.imputed_rows ?? []) {
      const rowIndex = item.row_index;
      if (typeof rowIndex !== 'number' || item.value == null) continue;
      if (this.isMissing(input.imputedRows[rowIndex]?.[input.column])) {
        input.imputedRows[rowIndex][input.column] = String(item.value);
        count += 1;
      }
    }
    return count;
  }
}
