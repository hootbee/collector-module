import { Injectable } from '@nestjs/common';
import { stableHash } from '../../common/text';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildKnowledgeEntry,
  buildQueryMatchSignals,
  connectorSearchMetadata,
  fetchJson,
  stripHtml,
  truncateText,
  envNumber,
} from './connector.utils';
import { knowledgeQueriesForSource, type DiscoveryPlan } from '../types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/collection-hit';

type CrossrefWork = {
  DOI?: string;
  URL?: string;
  title?: string[];
  abstract?: string;
  publisher?: string;
  type?: string;
  'container-title'?: string[];
  published?: { 'date-parts'?: number[][] };
};

type CrossrefResponse = {
  message?: {
    items?: CrossrefWork[];
  };
};

@Injectable()
export class CrossrefKnowledgeConnector implements DiscoveryConnector {
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
    const connectorMeta = connectorSearchMetadata('crossref');
    const sourceQueries = knowledgeQueriesForSource(plan, 'crossref');
    const queries = sourceQueries.slice(0, 3);
    const hits: KnowledgeDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<KnowledgeDiscoveryHit>['debug'] = [];
    const rows = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 20), 20),
    );

    for (const query of queries) {
      const url = new URL('https://api.crossref.org/works');
      url.searchParams.set('query', query);
      url.searchParams.set('rows', String(rows));
      if (process.env.CROSSREF_MAILTO?.trim()) {
        url.searchParams.set('mailto', process.env.CROSSREF_MAILTO.trim());
      }

      try {
        const response = await fetchJson<CrossrefResponse>(url.toString());
        const items = response.message?.items ?? [];
        let count = 0;

        for (const work of items.slice(0, rows)) {
          const title = work.title?.[0]?.trim();
          if (!title) {
            continue;
          }

          const summary = this.summary(work);
          const entry = buildKnowledgeEntry({
            id: `crossref:${this.identifier(work)}`,
            title,
            source: work['container-title']?.[0]?.trim() || 'Crossref',
            summary,
            sourceUrl: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : undefined),
            publisher: work.publisher?.trim(),
            retrievalHint: `Matched Crossref query: ${query}`,
            tags: [query, work.type ?? '', work.DOI ?? '', ...title.split(/\s+/)],
            kind: 'paper',
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
            connector: 'crossref',
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
          connector: 'crossref',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'crossref',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private identifier(work: CrossrefWork): string {
    if (work.DOI?.trim()) {
      return work.DOI.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    return String(stableHash(`${work.URL ?? ''}:${work.title?.[0] ?? ''}`));
  }

  private summary(work: CrossrefWork): string {
    const abstract = stripHtml(work.abstract ?? '').trim();
    if (abstract) {
      return truncateText(abstract, 280);
    }
    const container = work['container-title']?.[0]?.trim();
    const year = work.published?.['date-parts']?.[0]?.[0];
    return truncateText(
      [container, work.publisher, year ? String(year) : '', work.type].filter(Boolean).join(' | ') ||
        'Crossref metadata result',
      220,
    );
  }
}
