import { Injectable } from '@nestjs/common';
import type {
  ClassImbalanceStat,
  ColumnMissingStat,
  DatasetAnalysisResponse,
  DatasetRecord,
  NumericTargetStat,
  TargetStatSummary,
} from '../common/contracts';

function isMissing(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function stringifyLabel(value: unknown): string {
  if (value == null) {
    return '(missing)';
  }
  const text = String(value).trim();
  return text || '(missing)';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

@Injectable()
export class ProfilingService {
  computeMissingStats(rows: Array<Record<string, unknown>>, columns: string[]): ColumnMissingStat[] {
    const totalRows = rows.length;
    if (totalRows === 0) {
      return columns.map((column) => ({
        column,
        missingCount: 0,
        totalRows: 0,
        missingRate: 0,
      }));
    }

    return columns.map((column) => {
      let missingCount = 0;
      for (const row of rows) {
        if (isMissing(row[column])) {
          missingCount += 1;
        }
      }

      return {
        column,
        missingCount,
        totalRows,
        missingRate: missingCount / totalRows,
      };
    });
  }

  computeClassImbalance(
    rows: Array<Record<string, unknown>>,
    column: string,
    maxDistinct = 50,
  ): ClassImbalanceStat | null {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const label = stringifyLabel(row[column]);
      if (label === '(missing)') {
        continue;
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const distinctCount = counts.size;
    if (distinctCount === 0) {
      return {
        column,
        valueCounts: [],
        distinctCount: 0,
        minorityRatio: 0,
        majorityRatio: 0,
        imbalanceRatio: null,
        isHighlyImbalanced: false,
      };
    }

    if (distinctCount > maxDistinct) {
      return null;
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const valueCounts = [...counts.entries()]
      .map(([value, count]) => ({
        value,
        count,
        ratio: count / total,
      }))
      .sort((left, right) => right.count - left.count);

    const minCount = Math.min(...valueCounts.map((item) => item.count));
    const maxCount = Math.max(...valueCounts.map((item) => item.count));
    const minorityRatio = minCount / total;
    const majorityRatio = maxCount / total;
    const imbalanceRatio = minCount > 0 ? maxCount / minCount : null;

    return {
      column,
      valueCounts,
      distinctCount,
      minorityRatio,
      majorityRatio,
      imbalanceRatio,
      isHighlyImbalanced:
        imbalanceRatio != null && (imbalanceRatio >= 5 || minorityRatio <= 0.05),
    };
  }

  computeNumericTargetStats(
    rows: Array<Record<string, unknown>>,
    column: string,
  ): NumericTargetStat | null {
    const values = rows.map((row) => toNumber(row[column])).filter((value): value is number => value != null);
    if (values.length === 0) {
      return null;
    }

    const count = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / count;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;

    return {
      column,
      count,
      min: Math.min(...values),
      max: Math.max(...values),
      mean,
      std: Math.sqrt(variance),
    };
  }

  analyzeDataset(dataset: DatasetRecord): DatasetAnalysisResponse {
    const missingStats = this.computeMissingStats(dataset.rows, dataset.columns);
    const missingByColumn = new Map(missingStats.map((item) => [item.column, item]));
    const metadataCandidates = dataset.columns.filter((column) => {
      const stat = missingByColumn.get(column);
      return stat?.missingRate === 0 && !dataset.targetColumns.includes(column);
    });

    const imbalanceSummary: TargetStatSummary<ClassImbalanceStat>[] =
      dataset.taskType === 'classification' || dataset.taskType === 'anomaly'
        ? dataset.targetColumns.map((column) => ({
            col: column,
            stat: this.computeClassImbalance(dataset.rows, column),
          }))
        : [];

    const numericSummary: TargetStatSummary<NumericTargetStat>[] =
      dataset.taskType === 'regression'
        ? dataset.targetColumns.map((column) => ({
            col: column,
            stat: this.computeNumericTargetStats(dataset.rows, column),
          }))
        : [];

    return {
      sessionId: dataset.sessionId,
      datasetId: dataset.id,
      fileName: dataset.fileName,
      rowCount: dataset.rowCount,
      colCount: dataset.colCount,
      columns: [...dataset.columns],
      targetColumns: [...dataset.targetColumns],
      taskType: dataset.taskType,
      description: dataset.description,
      missingStats,
      imbalanceSummary,
      numericSummary,
      metadataCandidates,
    };
  }
}
