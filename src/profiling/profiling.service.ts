import { Injectable } from '@nestjs/common';
import type {
  ClassImbalanceStat,
  ColumnMissingStat,
  DatasetAnalysisResponse,
  DatasetRecord,
  ModalitySignal,
  NumericTargetStat,
  TaskSignal,
  TargetStatSummary,
} from '../common/contracts';

const idPattern =
  /(^id$|^uuid$|(^|_)(record_id|patient_id|user_id|session_id|row_id|doc_id|document_id|content_id|post_id|comment_id|message_id|sample_id|case_id|order_id|request_id)($|_))/i;
const temporalPattern =
  /(^date$|^time$|timestamp|datetime|created_at|updated_at|event_time|occurred_at|published_at|visit_date|year|month|day)/i;
const textPattern =
  /(^text$|content|prompt|body|article|sentence|response|answer|question|review|comment|transcript|message|post|passage|summary|headline|abstract|essay|writing)/i;
const metricPattern =
  /(score|count|ratio|rate|amount|price|close|open|high|low|volume|return|volatility|rsi|macd|signal|index|value|prob|pct|percent|length|size|duration|age)/i;
const transactionPattern =
  /(transaction|merchant|payment|chargeback|card|account|transfer|amount|balance|invoice|settlement)/i;
const longitudinalPattern =
  /(visit|encounter|admission|discharge|cohort|follow[_ -]?up|medication|lab|patient)/i;
const timeSeriesPattern =
  /(forecast|time[ -]?series|historical|history|ohlcv|open|high|low|close|volume|return|volatility|rsi|macd|price|market)/i;
const contentAuthenticityPattern =
  /(ai|human|generated|machine|llm|gpt|authenticity|provenance|source)/i;
const authorshipPattern =
  /(author|authorship|writer|writing style|stylometry|essay|composition|linguistic signature)/i;

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

function sampleNonMissingValues(
  rows: Array<Record<string, unknown>>,
  column: string,
  limit = 80,
): unknown[] {
  const result: unknown[] = [];
  for (const row of rows) {
    const value = row[column];
    if (isMissing(value)) {
      continue;
    }
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function hasPattern(values: string[], pattern: RegExp): boolean {
  return values.some((value) => pattern.test(value));
}

function isDateLike(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (
    /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(normalized) ||
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(normalized) ||
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(normalized)
  ) {
    return true;
  }

  const hasDateDelimiter = /[-/:T]/.test(normalized);
  const hasMonthLikeToken = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    normalized,
  );

  if (!hasDateDelimiter && !hasMonthLikeToken) {
    return false;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed);
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
    const roleInference = this.inferColumnRoles(dataset);

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
    const labelHints = imbalanceSummary.flatMap((item) => item.stat?.valueCounts.map((value) => value.value) ?? []);
    const modalitySignals = this.inferModalitySignals(dataset, roleInference);
    const taskSignals = this.inferTaskSignals(dataset, roleInference, labelHints, modalitySignals);

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
      metadataCandidates: roleInference.metadataCandidates,
      featureColumns: roleInference.featureColumns,
      inferredTextColumns: roleInference.inferredTextColumns,
      inferredIdColumns: roleInference.inferredIdColumns,
      inferredTemporalColumns: roleInference.inferredTemporalColumns,
      taskSignals,
      modalitySignals,
    };
  }

  private inferColumnRoles(dataset: DatasetRecord): {
    metadataCandidates: string[];
    featureColumns: string[];
    inferredTextColumns: string[];
    inferredIdColumns: string[];
    inferredTemporalColumns: string[];
  } {
    const inferredIdColumns: string[] = [];
    const inferredTemporalColumns: string[] = [];
    const inferredTextColumns: string[] = [];
    const targetSet = new Set(dataset.targetColumns);

    for (const column of dataset.columns) {
      if (targetSet.has(column)) {
        continue;
      }

      const values = sampleNonMissingValues(dataset.rows, column);
      const stringValues = values.map((value) => toText(value)).filter(Boolean);
      const uniqueCount = new Set(stringValues).size;
      const avgLength =
        stringValues.length > 0
          ? stringValues.reduce((sum, value) => sum + value.length, 0) / stringValues.length
          : 0;
      const whitespaceRatio =
        stringValues.length > 0
          ? stringValues.filter((value) => /\s/.test(value)).length / stringValues.length
          : 0;
      const distinctRatio = values.length > 0 ? uniqueCount / values.length : 0;
      const numericRatio =
        values.length > 0
          ? values.filter((value) => toNumber(value) != null).length / values.length
          : 0;
      const codeLikeRatio =
        stringValues.length > 0
          ? stringValues.filter((value) => /[a-z]/i.test(value) || /[-_]/.test(value)).length /
            stringValues.length
          : 0;
      const parseableDateRatio =
        stringValues.length > 0
          ? stringValues.filter((value) => isDateLike(value)).length / stringValues.length
          : 0;

      const looksLikeIdByName = idPattern.test(column);
      const looksLikeTemporalByName = temporalPattern.test(column);
      const looksLikeTextByName = textPattern.test(column);
      const looksLikeMetricByName = metricPattern.test(column);
      const looksLikeTextByValues =
        stringValues.length > 0 && avgLength >= 32 && whitespaceRatio >= 0.55;
      const looksLikeIdByValues =
        values.length >= 8 &&
        distinctRatio >= 0.98 &&
        avgLength > 0 &&
        avgLength <= 48 &&
        whitespaceRatio <= 0.3 &&
        parseableDateRatio < 0.4 &&
        !looksLikeMetricByName &&
        (numericRatio < 0.35 || codeLikeRatio >= 0.55);

      const isTemporal = looksLikeTemporalByName || parseableDateRatio >= 0.7;
      const isText = looksLikeTextByName || (!isTemporal && !looksLikeIdByName && looksLikeTextByValues);
      const isId = !isText && (looksLikeIdByName || (!isTemporal && looksLikeIdByValues));

      if (isId) {
        inferredIdColumns.push(column);
        continue;
      }
      if (isTemporal) {
        inferredTemporalColumns.push(column);
        continue;
      }
      if (isText) {
        inferredTextColumns.push(column);
      }
    }

    const metadataCandidates = [...inferredIdColumns, ...inferredTemporalColumns];
    const metadataSet = new Set(metadataCandidates);
    const featureColumns = dataset.columns.filter(
      (column) => !targetSet.has(column) && !metadataSet.has(column),
    );

    return {
      metadataCandidates,
      featureColumns,
      inferredTextColumns: inferredTextColumns.filter((column) => featureColumns.includes(column)),
      inferredIdColumns,
      inferredTemporalColumns,
    };
  }

  private inferTaskSignals(
    dataset: DatasetRecord,
    roleInference: {
      featureColumns: string[];
      inferredTextColumns: string[];
      inferredTemporalColumns: string[];
    },
    labelHints: string[],
    modalitySignals: ModalitySignal[],
  ): TaskSignal[] {
    const signals: TaskSignal[] = [];
    const columnBlob = dataset.columns.join(' ');
    const featureBlob = roleInference.featureColumns.join(' ');
    const description = dataset.description;
    const labelBlob = labelHints.join(' ');
    const combinedBlob = [columnBlob, featureBlob, description, labelBlob].join(' ');
    const hasTextSignals = roleInference.inferredTextColumns.length > 0 || /text|document|content|prompt/i.test(combinedBlob);

    if (dataset.taskType === 'classification') {
      signals.push('classification');
    } else if (dataset.taskType === 'regression') {
      signals.push('regression');
    } else if (dataset.taskType === 'anomaly') {
      signals.push('anomaly-detection');
    }

    if (
      dataset.taskType === 'regression' &&
      modalitySignals.includes('time-series') &&
      (roleInference.inferredTemporalColumns.length > 0 || timeSeriesPattern.test(combinedBlob))
    ) {
      signals.push('time-series-forecasting');
    }

    if (
      hasTextSignals &&
      contentAuthenticityPattern.test(combinedBlob) &&
      (dataset.taskType === 'classification' || /classification|detection/i.test(description))
    ) {
      signals.push('content-authenticity');
    }

    if (
      hasTextSignals &&
      authorshipPattern.test(combinedBlob)
    ) {
      signals.push('authorship-attribution');
    }

    return [...new Set(signals)];
  }

  private inferModalitySignals(
    dataset: DatasetRecord,
    roleInference: {
      featureColumns: string[];
      inferredTextColumns: string[];
      inferredTemporalColumns: string[];
    },
  ): ModalitySignal[] {
    const signals: ModalitySignal[] = ['tabular'];
    const columnBlob = dataset.columns.join(' ');
    const featureBlob = roleInference.featureColumns.join(' ');
    const description = dataset.description;
    const combinedBlob = [columnBlob, featureBlob, description].join(' ');

    if (roleInference.inferredTextColumns.length > 0 || /text|document|content|prompt/i.test(combinedBlob)) {
      signals.push('text');
    }

    if (
      roleInference.inferredTextColumns.length >= 2 ||
      /article|document|essay|review|comment|transcript|response|body|content/i.test(combinedBlob)
    ) {
      signals.push('document');
    }

    if (
      roleInference.inferredTemporalColumns.length > 0 &&
      (dataset.taskType === 'regression' || timeSeriesPattern.test(combinedBlob))
    ) {
      signals.push('time-series');
    }

    if (transactionPattern.test(combinedBlob)) {
      signals.push('transaction');
    }

    if (longitudinalPattern.test(combinedBlob) && roleInference.inferredTemporalColumns.length > 0) {
      signals.push('longitudinal');
    }

    return [...new Set(signals)];
  }
}
