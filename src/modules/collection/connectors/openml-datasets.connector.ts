import { Injectable } from '@nestjs/common';
import { tokenize, uniqueKeepOrder } from '../../../common/text';
import type { DiscoveryContext } from '../../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  connectorSearchMetadata,
  envNumber,
  fetchJson,
} from './connector.utils';
import { datasetQueriesForSource, type DiscoveryPlan } from '../types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/collection-hit';

type OpenMlDatasetQuality = {
  name?: string;
  value?: string;
};

type OpenMlDatasetSummary = {
  did?: number | string;
  name?: string;
  version?: number | string;
  status?: string;
  format?: string;
  file_id?: number | string;
  quality?: OpenMlDatasetQuality[];
};

type OpenMlListResponse = {
  data?: {
    dataset?: OpenMlDatasetSummary[];
  };
};

type OpenMlDatasetDescription = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  format?: string;
  creator?: string;
  licence?: string;
  url?: string;
  parquet_url?: string;
  default_target_attribute?: string;
  citation?: string;
  tag?: string[];
  status?: string;
  language?: string;
  original_data_url?: string;
};

type OpenMlDetailResponse = {
  data_set_description?: OpenMlDatasetDescription;
};

@Injectable()
export class OpenMlDatasetsConnector implements DiscoveryConnector {
  async searchKnowledgeHits(
    _plan: DiscoveryPlan,
    _context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    return {
      hits: [],
      debug: [],
    };
  }

  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const connectorMeta = connectorSearchMetadata('openml');
    const sourceQueries = datasetQueriesForSource(plan, 'openml');
    const queries = sourceQueries.slice(0, 3);
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const limit = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 20), 20),
    );
    const seenIds = new Set<string>();

    for (const query of queries) {
      try {
        let count = 0;
        const triedVariants: string[] = [];
        let lastError: string | null = null;

        for (const variant of this.queryVariants(query, context)) {
          triedVariants.push(variant);
          let datasets: OpenMlDatasetSummary[] = [];
          try {
            datasets = await this.listDatasets(variant, limit);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            continue;
          }
          if (datasets.length === 0) {
            continue;
          }

          for (const dataset of datasets) {
            const id = String(dataset.did ?? '').trim();
            if (!id || seenIds.has(id)) {
              continue;
            }

            const detail = await this.describeDataset(id);
            const description = detail.data_set_description;
            if (!description) {
              continue;
            }
            const name = this.stringValue(description?.name);
            if (!name) {
              continue;
            }

            const entry = buildDatasetEntry({
              id: `openml:${id}`,
              name,
              provider: 'OpenML',
              providerDetail: this.providerDetail(description, dataset),
              publisher: this.stringValue(description.creator) || 'OpenML contributor',
              description: this.stringValue(description.description) || `${name} dataset on OpenML.`,
              rowsHint: this.rowsHint(dataset),
              modality: this.modalityLabel(description, dataset),
              licenseHint: this.stringValue(description.licence) || 'See OpenML dataset page',
              sourceUrl: `https://www.openml.org/search?type=data&id=${id}`,
              downloadUrl: this.downloadUrl(description, id),
              downloadMethod: this.downloadMethod(description),
              downloadHint: this.downloadHint(description, id),
              downloadReference: id,
              retrievalHint: `Matched OpenML query "${variant}" from base "${query}"`,
              tags: this.tags(query, description, dataset),
            });

            const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.providerDetail ?? ''} ${entry.modality}`;
            const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
              text,
              entry.tags,
              sourceQueries,
              plan.mustInclude,
            );

            hits.push({
              id: entry.id,
              kind: 'dataset',
              connector: 'openml',
              sourceType: connectorMeta.sourceType,
              sourcePriority: connectorMeta.priority,
              sourceReliability: connectorMeta.reliability,
              title: entry.name,
              text,
              tags: entry.tags,
              domainIds: entry.domainIds ?? [],
              taskSignals: entry.taskSignals ?? [],
              modalitySignals: entry.modalitySignals ?? [],
              modality: entry.modalityType ?? (context.modality === 'text' ? 'text' : 'table'),
              negativeTags: entry.negativeTags ?? [],
              matchedQueries,
              matchedTerms,
              directDownloadAvailable: this.hasDirectDownload(description),
              entry,
            });
            seenIds.add(id);
            count += 1;
          }

          if (count > 0) {
            break;
          }
        }

        debug.push({
          id: query,
          connector: 'openml',
          matchedQueries: [query],
          matchedTerms: triedVariants.slice(0, 5),
          status: count > 0 || lastError == null ? 'ok' : 'error',
          count,
          error: count > 0 ? undefined : lastError ?? undefined,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'openml',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private async listDatasets(query: string, limit: number): Promise<OpenMlDatasetSummary[]> {
    const url = `https://www.openml.org/api/v1/json/data/list/data_name/${encodeURIComponent(query)}/limit/${limit}`;
    const response = await fetchJson<OpenMlListResponse>(url);
    return response.data?.dataset ?? [];
  }

  private async describeDataset(id: string): Promise<OpenMlDetailResponse> {
    return fetchJson<OpenMlDetailResponse>(`https://www.openml.org/api/v1/json/data/${id}`);
  }

  private providerDetail(description: OpenMlDatasetDescription, dataset: OpenMlDatasetSummary): string {
    return [
      `did=${description.id ?? dataset.did ?? ''}`.trim(),
      description.version ? `version=${description.version}` : '',
      this.stringValue(description.format) || this.stringValue(dataset.format)
        ? `format=${this.stringValue(description.format) || this.stringValue(dataset.format)}`
        : '',
      this.stringValue(description.default_target_attribute)
        ? `target=${this.stringValue(description.default_target_attribute)}`
        : '',
      this.stringValue(description.status) || this.stringValue(dataset.status)
        ? `status=${this.stringValue(description.status) || this.stringValue(dataset.status)}`
        : '',
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private rowsHint(dataset: OpenMlDatasetSummary): string {
    const quality = this.qualityMap(dataset.quality);
    const instances = quality.get('numberofinstances');
    const features = quality.get('numberoffeatures');
    const classes = quality.get('numberofclasses');

    return [
      instances ? `${Number(instances).toLocaleString()} rows` : '',
      features ? `${Number(features).toLocaleString()} features` : '',
      classes ? `${Number(classes).toLocaleString()} classes` : '',
      !instances && !features && !classes ? 'See OpenML dataset page' : '',
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private modalityLabel(description: OpenMlDatasetDescription, dataset: OpenMlDatasetSummary): string {
    const combined = [
      description.name,
      description.description,
      description.language,
      ...this.normalizeStringArray(description.tag),
      dataset.format,
    ]
      .map((value) => this.stringValue(value))
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (
      combined.includes('text') ||
      combined.includes('document') ||
      combined.includes('language') ||
      combined.includes('authorship') ||
      combined.includes('sentiment') ||
      combined.includes('spam') ||
      combined.includes('intent')
    ) {
      return 'text corpus';
    }
    if (
      combined.includes('time series') ||
      combined.includes('timeseries') ||
      combined.includes('forecast') ||
      combined.includes('stock')
    ) {
      return 'time series';
    }
    return 'dataset';
  }

  private tags(query: string, description: OpenMlDatasetDescription, dataset: OpenMlDatasetSummary): string[] {
    return uniqueKeepOrder([
      query,
      this.stringValue(description.name),
      this.stringValue(description.language),
      this.stringValue(description.creator),
      this.stringValue(description.default_target_attribute),
      ...this.normalizeStringArray(description.tag),
      ...tokenize(this.stringValue(description.name)),
      ...tokenize(this.stringValue(description.description)),
      ...tokenize(this.stringValue(description.creator)),
      ...tokenize(query),
    ]).slice(0, 28);
  }

  private downloadUrl(description: OpenMlDatasetDescription, id: string): string {
    return (
      this.stringValue(description.parquet_url) ||
      this.stringValue(description.original_data_url) ||
      this.stringValue(description.url) ||
      `https://www.openml.org/search?type=data&id=${id}`
    );
  }

  private downloadMethod(description: OpenMlDatasetDescription): 'direct' | 'api' {
    if (this.hasDirectDownload(description)) {
      return 'direct';
    }
    return 'api';
  }

  private downloadHint(description: OpenMlDatasetDescription, id: string): string {
    const directUrl =
      this.stringValue(description.parquet_url) ||
      this.stringValue(description.original_data_url) ||
      this.stringValue(description.url);
    if (directUrl) {
      return `Use the provided OpenML data URL or API metadata for dataset ${id}.`;
    }
    return `Open the OpenML dataset page for ${id} and follow the API/data links.`;
  }

  private hasDirectDownload(description: OpenMlDatasetDescription): boolean {
    const candidate =
      this.stringValue(description.parquet_url) ||
      this.stringValue(description.original_data_url) ||
      this.stringValue(description.url);
    return Boolean(candidate && /\.(csv|tsv|json|jsonl|zip|gz|parquet|arff|xlsx?)($|\?)/i.test(candidate));
  }

  private qualityMap(qualities: OpenMlDatasetQuality[] | undefined): Map<string, string> {
    const map = new Map<string, string>();
    for (const item of qualities ?? []) {
      const key = item.name?.trim().toLowerCase();
      const value = item.value?.trim();
      if (!key || !value) {
        continue;
      }
      map.set(key, value);
    }
    return map;
  }

  private queryVariants(query: string, context: DiscoveryContext): string[] {
    const stopwords = new Set([
      'dataset',
      'benchmark',
      'corpus',
      'with',
      'and',
      'metadata',
      'using',
      'for',
      'the',
      'generated',
    ]);
    const compressed = uniqueKeepOrder(tokenize(query).filter((token) => !stopwords.has(token)))
      .slice(0, 3)
      .join(' ');
    const compressedTokens = tokenize(compressed);
    const bigram = compressedTokens.slice(0, 2).join(' ');
    const unigram = compressedTokens[0] ?? '';

    return uniqueKeepOrder([
      query,
      this.trimDatasetSuffix(query),
      compressed,
      bigram,
      unigram,
      ...(context.modality === 'text'
        ? ['authorship', 'text classification', 'sentiment', 'intent', 'spam']
        : []),
      ...(context.taskSignals.includes('time-series-forecasting')
        ? ['stock', 'time series', 'forecasting']
        : []),
    ])
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => value.length <= 80)
      .filter((value) => value.length >= 3);
  }

  private trimDatasetSuffix(query: string): string {
    return query
      .replace(/\b(dataset|benchmark|corpus|with metadata|with prompts and content|with topic and language metadata)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stringValue(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => this.stringValue(item))
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>)
        .map((item) => this.stringValue(item))
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    return '';
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      const single = this.stringValue(value);
      return single ? [single] : [];
    }
    return value
      .map((item) => this.stringValue(item))
      .filter(Boolean);
  }
}
