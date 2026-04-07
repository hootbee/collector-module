import { Injectable } from '@nestjs/common';
import type {
  CollectionKind,
  CollectionLlmPlan,
  CollectionSourceId,
  DatasetRecord,
  DiscoveryContext,
  ModalitySignal,
  TaskSignal,
  TaskType,
} from '../common/contracts';
import { nowIso } from '../common/time';
import { tokenize, uniqueKeepOrder } from '../common/text';
import type { DiscoveryPlan } from '../discovery/types/discovery-plan';

export type CollectionRequest = {
  query: string;
  kind: CollectionKind;
  requestedSources: CollectionSourceId[];
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  mustInclude?: string[];
  mustAvoid?: string[];
  llmPlan?: CollectionLlmPlan | null;
};

const stopwords = new Set([
  'dataset',
  'datasets',
  'benchmark',
  'corpus',
  'with',
  'and',
  'for',
  'the',
  'using',
  'from',
]);

@Injectable()
export class CollectionPlannerService {
  build(request: CollectionRequest): { context: DiscoveryContext; plan: DiscoveryPlan } {
    const inferredTaskSignals = request.taskSignals?.length
      ? [...request.taskSignals]
      : request.llmPlan?.taskSignals?.length
        ? [...request.llmPlan.taskSignals]
      : this.inferTaskSignals(request.query);
    const inferredModalitySignals = request.modalitySignals?.length
      ? [...request.modalitySignals]
      : request.llmPlan?.modalitySignals?.length
        ? [...request.llmPlan.modalitySignals]
      : this.inferModalitySignals(request.query);
    const modality: DiscoveryContext['modality'] = inferredModalitySignals.includes('text')
      ? 'text'
      : inferredModalitySignals.includes('document')
        ? 'hybrid'
        : 'table';
    const compressedQuery = this.compressQuery(request.query);
    const mustInclude = uniqueKeepOrder([
      ...(request.mustInclude ?? []).map((value) => value.trim()).filter(Boolean),
      ...(request.llmPlan?.mustInclude ?? []).map((value) => value.trim()).filter(Boolean),
      ...tokenize(request.query).slice(0, 8),
    ]);
    const mustAvoid = uniqueKeepOrder([
      ...(request.mustAvoid ?? []).map((value) => value.trim()).filter(Boolean),
      ...(request.llmPlan?.mustAvoid ?? []).map((value) => value.trim()).filter(Boolean),
    ]);

    const canonicalDatasetQueries = uniqueKeepOrder(
      [request.query, compressedQuery, ...this.datasetFallbackQueries(request.query, inferredTaskSignals, inferredModalitySignals)]
        .map((value) => value.trim())
        .filter(Boolean),
    ).slice(0, 8);
    const canonicalKnowledgeQueries = uniqueKeepOrder(
      [
        `${request.query} paper`,
        `${compressedQuery} paper`,
        ...this.knowledgeFallbackQueries(request.query, inferredTaskSignals, inferredModalitySignals),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ).slice(0, 8);

    const datasetSourceQueries: DiscoveryPlan['datasetSourceQueries'] = {
      'seed-catalog': this.mergeSourceQueries(canonicalDatasetQueries.slice(0, 5), request.llmPlan?.datasetSourceQueries?.['seed-catalog']),
      huggingface: uniqueKeepOrder([
        ...canonicalDatasetQueries,
        ...this.huggingFaceQueries(request.query, compressedQuery, inferredModalitySignals, inferredTaskSignals),
        ...(request.llmPlan?.datasetSourceQueries?.huggingface ?? []),
      ]).slice(0, 8),
      openml: uniqueKeepOrder([
        compressedQuery,
        ...this.shortQueryVariants(compressedQuery),
        ...(request.llmPlan?.datasetSourceQueries?.openml ?? []),
      ]).slice(0, 6),
      uci: uniqueKeepOrder([
        compressedQuery,
        ...this.shortQueryVariants(compressedQuery),
        ...(request.llmPlan?.datasetSourceQueries?.uci ?? []),
      ]).slice(0, 6),
      kaggle: uniqueKeepOrder([
        `${request.query} dataset`,
        `${compressedQuery} dataset`,
        request.query,
        compressedQuery,
        ...(request.llmPlan?.datasetSourceQueries?.kaggle ?? []),
      ]).slice(0, 8),
    };

    const knowledgeSourceQueries: DiscoveryPlan['knowledgeSourceQueries'] = {
      'seed-catalog': this.mergeSourceQueries(canonicalKnowledgeQueries.slice(0, 5), request.llmPlan?.knowledgeSourceQueries?.['seed-catalog']),
      serpapi: uniqueKeepOrder([
        ...canonicalKnowledgeQueries,
        `${request.query} overview`,
        ...(request.llmPlan?.knowledgeSourceQueries?.serpapi ?? []),
      ]).slice(0, 8),
      crossref: uniqueKeepOrder([
        ...this.shortQueryVariants(compressedQuery).map((value) => `${value} paper`),
        `${compressedQuery} benchmark`,
        ...(request.llmPlan?.knowledgeSourceQueries?.crossref ?? []),
      ]).slice(0, 8),
    };

    const plan: DiscoveryPlan = {
      selectedDomainIds: [],
      taskSignals: [...inferredTaskSignals],
      modalitySignals: [...inferredModalitySignals],
      canonicalKnowledgeQueries,
      fallbackKnowledgeQueries: uniqueKeepOrder(this.knowledgeFallbackQueries(request.query, inferredTaskSignals, inferredModalitySignals)).slice(0, 6),
      knowledgeQueries: uniqueKeepOrder([...canonicalKnowledgeQueries, ...Object.values(knowledgeSourceQueries).flat()]).slice(0, 10),
      canonicalDatasetQueries,
      fallbackDatasetQueries: uniqueKeepOrder(this.datasetFallbackQueries(request.query, inferredTaskSignals, inferredModalitySignals)).slice(0, 6),
      datasetQueries: uniqueKeepOrder([...canonicalDatasetQueries, ...Object.values(datasetSourceQueries).flat()]).slice(0, 10),
      datasetSourceQueries,
      knowledgeSourceQueries,
      mustInclude,
      mustAvoid,
    };

    return {
      context: this.buildContext(request.query, inferredTaskSignals, inferredModalitySignals, modality, mustInclude),
      plan,
    };
  }

  private mergeSourceQueries(baseline: string[], llmQueries?: string[]): string[] {
    return uniqueKeepOrder([...(llmQueries ?? []), ...baseline]).slice(0, 8);
  }

  private buildContext(
    query: string,
    taskSignals: TaskSignal[],
    modalitySignals: ModalitySignal[],
    modality: DiscoveryContext['modality'],
    mustInclude: string[],
  ): DiscoveryContext {
    const textColumns = modality === 'text' ? ['query_text'] : [];
    const syntheticDataset: DatasetRecord = {
      id: `collection-dataset-${tokenize(query).slice(0, 4).join('-') || 'query'}`,
      sessionId: 'collection',
      fileName: 'collection-query',
      filePath: '',
      rowCount: 0,
      colCount: 0,
      columns: [],
      rows: [],
      targetColumns: [],
      taskType: this.toTaskType(taskSignals),
      description: query,
      createdAt: nowIso(),
    };

    return {
      dataset: syntheticDataset,
      selectedDomains: [],
      selectedDomainIds: [],
      primaryDomainId: null,
      taskSignals,
      modalitySignals,
      metadataColumns: [],
      featureColumns: [],
      textColumns,
      idColumns: [],
      temporalColumns: [],
      supportColumns: [],
      labelHints: [],
      modality,
      descriptionSignals: [query],
      expandedKeywords: mustInclude,
      generatedQueries: [query],
    };
  }

  private inferTaskSignals(query: string): TaskSignal[] {
    const tokens = new Set(tokenize(query));
    const signals: TaskSignal[] = [];
    if (['classification', 'classify', 'spam', 'sentiment', 'authorship', 'generated'].some((token) => tokens.has(token))) {
      signals.push('classification');
    }
    if (['forecast', 'forecasting', 'prediction', 'price', 'stock', 'market', 'ohlcv'].some((token) => tokens.has(token))) {
      signals.push('regression', 'time-series-forecasting');
    }
    if (['anomaly', 'fraud', 'outlier'].some((token) => tokens.has(token))) {
      signals.push('anomaly-detection');
    }
    if (['authorship', 'author'].some((token) => tokens.has(token))) {
      signals.push('authorship-attribution');
    }
    if (['generated', 'authenticity', 'provenance', 'human', 'machine'].some((token) => tokens.has(token))) {
      signals.push('content-authenticity');
    }
    const fallbackSignals: TaskSignal[] = signals.length > 0 ? signals : ['classification'];
    return [...new Set(fallbackSignals)];
  }

  private inferModalitySignals(query: string): ModalitySignal[] {
    const tokens = new Set(tokenize(query));
    const signals: ModalitySignal[] = ['tabular'];
    if (['text', 'document', 'corpus', 'prompt', 'content', 'article', 'essay', 'review', 'language'].some((token) => tokens.has(token))) {
      signals.push('text', 'document');
    }
    if (['stock', 'market', 'ohlcv', 'forecast', 'temporal', 'series'].some((token) => tokens.has(token))) {
      signals.push('time-series');
    }
    return [...new Set(signals)];
  }

  private datasetFallbackQueries(query: string, taskSignals: TaskSignal[], modalitySignals: ModalitySignal[]): string[] {
    const variants = [this.compressQuery(query)];
    if (modalitySignals.includes('text')) {
      variants.push('text classification', 'authorship attribution', 'generated text detection');
    }
    if (taskSignals.includes('time-series-forecasting')) {
      variants.push('time series forecasting', 'stock prediction', 'ohlcv');
    }
    return uniqueKeepOrder(variants.filter(Boolean));
  }

  private knowledgeFallbackQueries(query: string, taskSignals: TaskSignal[], modalitySignals: ModalitySignal[]): string[] {
    const variants = [`${this.compressQuery(query)} overview`, `${this.compressQuery(query)} paper`];
    if (modalitySignals.includes('text')) {
      variants.push('authorship attribution paper', 'generated text detection paper');
    }
    if (taskSignals.includes('time-series-forecasting')) {
      variants.push('financial time series forecasting paper');
    }
    return uniqueKeepOrder(variants.filter(Boolean));
  }

  private huggingFaceQueries(
    query: string,
    compressedQuery: string,
    modalitySignals: ModalitySignal[],
    taskSignals: TaskSignal[],
  ): string[] {
    const variants = [query, compressedQuery];
    if (modalitySignals.includes('text')) {
      variants.push('text classification', 'authorship attribution', 'generated text detection', 'hc3');
    }
    if (taskSignals.includes('time-series-forecasting')) {
      variants.push('stock forecasting', 'ohlcv', 'time series forecasting');
    }
    return uniqueKeepOrder(variants.filter(Boolean));
  }

  private shortQueryVariants(query: string): string[] {
    const tokens = tokenize(query).filter((token) => !stopwords.has(token));
    return uniqueKeepOrder([
      tokens.slice(0, 3).join(' '),
      tokens.slice(0, 2).join(' '),
      tokens[0] ?? '',
    ]).filter(Boolean);
  }

  private compressQuery(query: string): string {
    return tokenize(query)
      .filter((token) => !stopwords.has(token))
      .slice(0, 4)
      .join(' ');
  }

  private toTaskType(taskSignals: TaskSignal[]): TaskType {
    if (taskSignals.includes('regression') || taskSignals.includes('time-series-forecasting')) {
      return 'regression';
    }
    if (taskSignals.includes('anomaly-detection')) {
      return 'anomaly';
    }
    return 'classification';
  }
}
