import { Injectable } from '@nestjs/common';
import { stableHash } from '../../common/text';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildKnowledgeEntry,
  buildQueryMatchSignals,
  connectorSearchMetadata,
  envNumber,
  fetchJson,
} from './connector.utils';
import { knowledgeQueriesForSource, type DiscoveryPlan } from '../types/collection-plan';
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
    _plan: DiscoveryPlan,
    _context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    return {
      hits: [],
      debug: [],
    };
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
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 10), 8),
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
}
