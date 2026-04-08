import { Injectable } from '@nestjs/common';
import { tokenize, uniqueKeepOrder } from '../../common/text';
import type { DiscoveryContext } from '../../common/contracts';
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

type HuggingFaceDataset = {
  id?: string;
  author?: string;
  description?: string;
  tags?: string[];
  cardData?: {
    license?: string | { name?: string };
    pretty_name?: string;
    dataset_info?: {
      dataset_size?: number;
      size_in_bytes?: number;
      splits?: Array<{ num_examples?: number }>;
    };
  };
};

@Injectable()
export class HuggingFaceDatasetsConnector implements DiscoveryConnector {
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
    const connectorMeta = connectorSearchMetadata('huggingface');
    const sourceQueries = datasetQueriesForSource(plan, 'huggingface');
    const queries = sourceQueries.slice(0, 3);
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const limit = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 10), 10),
    );
    const seenIds = new Set<string>();

    for (const query of queries) {
      try {
        let count = 0;
        const triedVariants: string[] = [];
        const queryVariants = this.queryVariants(query, context);
        const headers: HeadersInit = {};
        if (process.env.HF_TOKEN?.trim()) {
          headers.Authorization = `Bearer ${process.env.HF_TOKEN.trim()}`;
        }

        for (const variant of queryVariants) {
          triedVariants.push(variant);
          const url = new URL('https://huggingface.co/api/datasets');
          url.searchParams.set('search', variant);
          url.searchParams.set('limit', String(limit));
          url.searchParams.set('full', 'true');

          const response = await fetchJson<HuggingFaceDataset[]>(url.toString(), { headers });
          if (response.length === 0) {
            continue;
          }

          for (const item of response.slice(0, limit)) {
            const id = item.id?.trim();
            if (!id || seenIds.has(id)) {
              continue;
            }
            seenIds.add(id);
            const tags = this.datasetTags(item, variant);
            const title = item.cardData?.pretty_name?.trim() || id;
            const description = item.description?.trim() || `${title} dataset on Hugging Face Hub.`;
            const entry = buildDatasetEntry({
              id: `hf:${id}`,
              name: title,
              provider: 'Hugging Face',
              providerDetail: [id, this.authorLabel(item)].filter(Boolean).join(' | '),
              publisher: this.authorLabel(item),
              description,
              rowsHint: this.rowsHint(item),
              modality: this.modalityLabel(tags),
              licenseHint: this.licenseHint(item),
              sourceUrl: `https://huggingface.co/datasets/${id}`,
              downloadUrl: `https://huggingface.co/datasets/${id}`,
              downloadMethod: 'source-page',
              downloadHint: `Open the Hugging Face dataset page for ${id} and download files from the repo tree or hub API.`,
              downloadReference: id,
              retrievalHint: `Matched Hugging Face query "${variant}" from base "${query}"`,
              tags,
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
              connector: 'huggingface',
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
              entry,
            });
            count += 1;
          }

          if (count > 0) {
            break;
          }
        }

        debug.push({
          id: query,
          connector: 'huggingface',
          matchedQueries: [query],
          matchedTerms: triedVariants.slice(0, 5),
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'huggingface',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private datasetTags(item: HuggingFaceDataset, query: string): string[] {
    return [
      ...new Set([
        ...((item.tags ?? []).slice(0, 16)),
        ...tokenize(item.id ?? ''),
        ...tokenize(item.author ?? ''),
        ...tokenize(item.cardData?.pretty_name ?? ''),
        ...tokenize(item.description ?? ''),
        ...tokenize(query),
      ]),
    ].slice(0, 24);
  }

  private rowsHint(item: HuggingFaceDataset): string {
    const splitCount = item.cardData?.dataset_info?.splits?.reduce(
      (sum, split) => sum + (split.num_examples ?? 0),
      0,
    );
    if (splitCount && splitCount > 0) {
      return `${splitCount.toLocaleString()} examples`;
    }
    const sizeBytes = item.cardData?.dataset_info?.dataset_size ?? item.cardData?.dataset_info?.size_in_bytes;
    if (sizeBytes && sizeBytes > 0) {
      return `Approx. ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return 'See dataset card';
  }

  private licenseHint(item: HuggingFaceDataset): string {
    const raw = item.cardData?.license;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    if (raw && typeof raw === 'object' && raw.name?.trim()) {
      return raw.name.trim();
    }
    const licenseTag = (item.tags ?? []).find((tag) => tag.startsWith('license:'));
    if (licenseTag) {
      return licenseTag.slice('license:'.length);
    }
    return 'See dataset card';
  }

  private modalityLabel(tags: string[]): string {
    const set = new Set(tags.map((tag) => tag.toLowerCase()));
    if (set.has('text-classification') || set.has('task_categories:text-classification') || set.has('text')) {
      return 'text corpus';
    }
    if (
      set.has('question-answering') ||
      set.has('task_categories:question-answering') ||
      set.has('summarization') ||
      set.has('task_categories:token-classification')
    ) {
      return 'document corpus';
    }
    if (set.has('time-series') || set.has('task_categories:time-series-forecasting')) {
      return 'time series';
    }
    return 'dataset';
  }

  private authorLabel(item: HuggingFaceDataset): string {
    return item.author?.trim() || '';
  }

  private queryVariants(query: string, context: DiscoveryContext): string[] {
    const lowered = query.toLowerCase();
    const variants = uniqueKeepOrder([
      query,
      this.trimDatasetSuffix(query),
      this.compressQuery(query),
      ...(context.modality === 'text'
        ? [
            'generated text detection',
            'ai generated text',
            'human vs ai text',
            'text classification',
            'authorship attribution',
            'content authenticity',
            'hc3',
          ]
        : []),
      ...(context.taskSignals.includes('time-series-forecasting')
        ? [
            'stock forecasting',
            'ohlcv',
            'time series forecasting',
            'market prediction',
          ]
        : []),
    ])
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => value.length >= 3);

    return variants.filter((value, index) => {
      if (index === 0) {
        return true;
      }
      return value.toLowerCase() !== lowered;
    });
  }

  private trimDatasetSuffix(query: string): string {
    return query
      .replace(/\b(dataset|benchmark|corpus|with metadata|with prompts and content|with topic and language metadata)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private compressQuery(query: string): string {
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
    ]);
    const tokens = tokenize(query).filter((token) => !stopwords.has(token));
    return uniqueKeepOrder(tokens).slice(0, 4).join(' ');
  }
}
