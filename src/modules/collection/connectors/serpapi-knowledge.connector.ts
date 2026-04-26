import { Injectable } from '@nestjs/common';
import { stableHash } from '../../../common/text';
import type { DiscoveryContext } from '../../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildKnowledgeEntry,
  buildQueryMatchSignals,
  connectorSearchMetadata,
  envNumber,
  fetchJson,
} from './connector.utils';
import {
  datasetQueriesForSource,
  knowledgeQueriesForSource,
  type DiscoveryPlan,
} from '../types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/collection-hit';

type SerpOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
};

type SerpApiResponse = {
  organic_results?: SerpOrganicResult[];
};

@Injectable()
export class SerpApiKnowledgeConnector implements DiscoveryConnector {
  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const connectorMeta = connectorSearchMetadata('serpapi');
    const apiKey = process.env.SERPAPI_API_KEY?.trim();
    if (!apiKey) {
      return {
        hits: [],
        debug: [
          {
            id: '__serpapi__',
            connector: 'serpapi',
            matchedQueries: [],
            matchedTerms: [],
            status: 'error',
            error: 'SERPAPI_API_KEY is not configured.',
          },
        ],
      };
    }

    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const limit = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 20), 24),
    );
    const sourceQueries = datasetQueriesForSource(plan, 'serpapi');

    for (const query of sourceQueries.slice(0, 3)) {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', `${query} dataset`);
      url.searchParams.set('num', String(limit));
      url.searchParams.set('api_key', apiKey);

      try {
        const response = await fetchJson<SerpApiResponse>(url.toString());
        const items = response.organic_results ?? [];
        let count = 0;

        for (const item of items.slice(0, limit)) {
          const title = item.title?.trim();
          const link = item.link?.trim();
          if (!title || !link || !this.isDatasetLike(item)) {
            continue;
          }

          const provider = item.source?.trim() || this.hostLabel(link);
          const entry = buildDatasetEntry({
            id: `serpapi:${String(stableHash(link)).replace('-', 'n')}`,
            name: title,
            provider: this.providerFromUrl(link, provider),
            description: item.snippet?.trim() || `${title} dataset candidate discovered by web search.`,
            rowsHint: 'See source page',
            modality: this.modalityFromText(title, item.snippet ?? '', context),
            licenseHint: 'See source page',
            sourceUrl: link,
            downloadUrl: link,
            downloadMethod: this.hasDirectDownloadSuffix(link) ? 'direct' : 'source-page',
            downloadHint: this.hasDirectDownloadSuffix(link)
              ? 'Direct file URL discovered from web search result.'
              : 'Open the source page and follow dataset or download links.',
            downloadReference: link,
            providerDetail: provider,
            publisher: provider,
            retrievalHint: `Matched SerpAPI dataset query: ${query}`,
            tags: [query, title, item.snippet ?? '', provider, this.hostLabel(link)],
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
            connector: 'serpapi',
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
              directDownloadAvailable: this.hasDirectDownloadSuffix(link),
              entry,
            });
          count += 1;
        }

        debug.push({
          id: query,
          connector: 'serpapi',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'serpapi',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  async searchKnowledgeHits(
    plan: DiscoveryPlan,
    _context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    const connectorMeta = connectorSearchMetadata('serpapi');
    const apiKey = process.env.SERPAPI_API_KEY?.trim();
    if (!apiKey) {
      return {
        hits: [],
        debug: [
          {
            id: '__serpapi__',
            connector: 'serpapi',
            matchedQueries: [],
            matchedTerms: [],
            status: 'error',
            error: 'SERPAPI_API_KEY is not configured.',
          },
        ],
      };
    }

    const hits: KnowledgeDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<KnowledgeDiscoveryHit>['debug'] = [];
    const limit = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 20), 24),
    );

    const sourceQueries = knowledgeQueriesForSource(plan, 'serpapi');
    for (const query of sourceQueries.slice(0, 3)) {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(limit));
      url.searchParams.set('api_key', apiKey);

      try {
        const response = await fetchJson<SerpApiResponse>(url.toString());
        const items = response.organic_results ?? [];
        let count = 0;

        for (const item of items.slice(0, limit)) {
          const title = item.title?.trim();
          const link = item.link?.trim();
          if (!title || !link) {
            continue;
          }

          const entry = buildKnowledgeEntry({
            id: `serpapi:${String(stableHash(link)).replace('-', 'n')}`,
            title,
            source: item.source?.trim() || this.hostLabel(link),
            summary: item.snippet?.trim() || `Web search result for ${query}`,
            sourceUrl: link,
            retrievalHint: `Matched SerpAPI query: ${query}`,
            tags: [query, title, item.snippet ?? '', this.hostLabel(link)],
            kind: this.kindFromUrl(link),
          });
          const text = `${entry.title} ${entry.summary} ${entry.source} ${entry.publisher ?? ''}`;
          const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
            text,
            entry.tags,
            sourceQueries,
            plan.mustInclude,
          );

          hits.push({
            id: entry.id,
            kind: 'knowledge',
            connector: 'serpapi',
            sourceType: connectorMeta.sourceType,
            sourcePriority: connectorMeta.priority,
            sourceReliability: connectorMeta.reliability,
            title: entry.title,
            text,
            tags: entry.tags,
            domainIds: entry.domainIds ?? [],
            taskSignals: entry.taskSignals ?? [],
            modalitySignals: entry.modalitySignals ?? [],
            modality: entry.modality ?? 'text',
            negativeTags: entry.negativeTags ?? [],
            matchedQueries,
            matchedTerms,
            entry,
          });
          count += 1;
        }

        debug.push({
          id: query,
          connector: 'serpapi',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'serpapi',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private hostLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'web';
    }
  }

  private kindFromUrl(url: string): 'paper' | 'guideline' | 'wiki' | 'standard' {
    const value = url.toLowerCase();
    if (value.includes('wikipedia.org')) {
      return 'wiki';
    }
    if (value.includes('arxiv.org') || value.includes('doi.org') || value.includes('crossref.org')) {
      return 'paper';
    }
    if (value.includes('standards') || value.includes('/standard')) {
      return 'standard';
    }
    return 'guideline';
  }

  private isDatasetLike(item: SerpOrganicResult): boolean {
    const title = item.title?.toLowerCase() ?? '';
    const snippet = item.snippet?.toLowerCase() ?? '';
    const link = item.link?.toLowerCase() ?? '';
    if (
      link.includes('huggingface.co/datasets/') ||
      link.includes('kaggle.com/datasets/') ||
      link.includes('openml.org') ||
      link.includes('archive.ics.uci.edu') ||
      link.includes('data.gov') ||
      link.includes('github.com') ||
      link.includes('raw.githubusercontent.com') ||
      link.includes('zenodo.org') ||
      link.includes('figshare.com')
    ) {
      return true;
    }
    return /dataset|datasets|benchmark|corpus|repository|archive|download|training data|tabular|csv|parquet|jsonl|open data|public data/.test(
      `${title} ${snippet}`,
    );
  }

  private providerFromUrl(url: string, fallback: string): string {
    const value = url.toLowerCase();
    if (value.includes('huggingface.co')) {
      return 'Hugging Face';
    }
    if (value.includes('kaggle.com')) {
      return 'Kaggle';
    }
    if (value.includes('openml.org')) {
      return 'OpenML';
    }
    if (value.includes('archive.ics.uci.edu')) {
      return 'UCI Machine Learning Repository';
    }
    return fallback;
  }

  private modalityFromText(
    title: string,
    snippet: string,
    context: DiscoveryContext,
  ): string {
    const text = `${title} ${snippet}`.toLowerCase();
    if (text.includes('text') || text.includes('prompt') || text.includes('corpus') || text.includes('document')) {
      return 'text corpus';
    }
    if (text.includes('time series') || text.includes('stock') || text.includes('ohlcv')) {
      return 'time series';
    }
    return context.modality === 'text' ? 'text corpus' : 'dataset';
  }

  private hasDirectDownloadSuffix(url: string): boolean {
    return /\.(csv|tsv|json|jsonl|zip|gz|parquet|arff|xlsx?)($|\?)/i.test(url);
  }
}
