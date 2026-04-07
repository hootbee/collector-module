import { Injectable } from '@nestjs/common';
import { tokenize } from '../../common/text';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  envNumber,
  fetchJson,
} from './connector.utils';
import type { DiscoveryPlan } from '../types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/discovery-hit';

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
    const queries = plan.datasetQueries.slice(0, 3);
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const limit = Math.max(2, Math.min(envNumber('DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE', 10), 10));

    for (const query of queries) {
      const url = new URL('https://huggingface.co/api/datasets');
      url.searchParams.set('search', query);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('full', 'true');

      try {
        const headers: HeadersInit = {};
        if (process.env.HF_TOKEN?.trim()) {
          headers.Authorization = `Bearer ${process.env.HF_TOKEN.trim()}`;
        }

        const response = await fetchJson<HuggingFaceDataset[]>(url.toString(), { headers });
        let count = 0;

        for (const item of response.slice(0, limit)) {
          const id = item.id?.trim();
          if (!id) {
            continue;
          }
          const tags = this.datasetTags(item, query);
          const title = item.cardData?.pretty_name?.trim() || id;
          const description = item.description?.trim() || `${title} dataset on Hugging Face Hub.`;
          const entry = buildDatasetEntry({
            id: `hf:${id}`,
            name: title,
            provider: 'Hugging Face',
            providerDetail: id,
            description,
            rowsHint: this.rowsHint(item),
            modality: this.modalityLabel(tags),
            licenseHint: this.licenseHint(item),
            sourceUrl: `https://huggingface.co/datasets/${id}`,
            retrievalHint: `Matched Hugging Face search query: ${query}`,
            tags,
          });
          const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.providerDetail ?? ''} ${entry.modality}`;
          const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
            text,
            entry.tags,
            plan.datasetQueries,
            plan.mustInclude,
          );

          hits.push({
            id: entry.id,
            kind: 'dataset',
            connector: 'huggingface',
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

        debug.push({
          id: query,
          connector: 'huggingface',
          matchedQueries: [query],
          matchedTerms: [],
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
    if (set.has('time-series') || set.has('task_categories:time-series-forecasting')) {
      return 'time series';
    }
    return 'dataset';
  }
}
