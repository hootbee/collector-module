import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  collapseWhitespace,
  envNumber,
  fetchText,
  stripHtml,
} from './connector.utils';
import type { DiscoveryPlan } from '../types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/discovery-hit';

type ParsedUciDatasetCard = {
  slug: string;
  title: string;
  description: string;
  sourceUrl: string;
  rowsHint: string;
  modality: string;
  tags: string[];
};

@Injectable()
export class UciDatasetsConnector implements DiscoveryConnector {
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
    const queries = plan.datasetQueries.slice(0, 2);
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const perQueryLimit = Math.max(2, Math.min(envNumber('DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE', 10), 6));

    for (const query of queries) {
      const url = `https://archive.ics.uci.edu/datasets?search=${encodeURIComponent(query)}`;

      try {
        const html = await fetchText(url);
        const parsed = this.parseDatasetCards(html).slice(0, perQueryLimit);
        let count = 0;

        for (const item of parsed) {
          const entry = buildDatasetEntry({
            id: `uci:${item.slug}`,
            name: item.title,
            provider: 'UCI Machine Learning Repository',
            description: item.description,
            rowsHint: item.rowsHint,
            modality: item.modality,
            licenseHint: 'See UCI dataset page',
            sourceUrl: item.sourceUrl,
            retrievalHint: `Matched UCI search query: ${query}`,
            tags: [query, ...item.tags],
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
            connector: 'uci',
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
          connector: 'uci',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'uci',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private parseDatasetCards(html: string): ParsedUciDatasetCard[] {
    const matches = [...html.matchAll(/href="\/dataset\/(\d+)(?:\/[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)];
    const results = new Map<string, ParsedUciDatasetCard>();

    for (const match of matches) {
      const datasetId = match[1];
      if (!datasetId || results.has(datasetId)) {
        continue;
      }

      const rawTitle = collapseWhitespace(stripHtml(match[2] ?? ''));
      if (!rawTitle || rawTitle.length < 3) {
        continue;
      }

      const index = match.index ?? 0;
      const window = html.slice(index, index + 1400);
      const windowText = collapseWhitespace(stripHtml(window));
      const description = this.extractDescription(windowText, rawTitle);
      const rowsHint = this.extractRowsHint(windowText);
      const modality = this.extractModality(windowText);
      const tags = [...new Set([rawTitle, windowText].flatMap((value) => value.split(/\s+/)).filter(Boolean))].slice(0, 20);

      results.set(datasetId, {
        slug: datasetId,
        title: rawTitle,
        description,
        sourceUrl: `https://archive.ics.uci.edu/dataset/${datasetId}`,
        rowsHint,
        modality,
        tags,
      });
    }

    return [...results.values()];
  }

  private extractDescription(windowText: string, title: string): string {
    const withoutTitle = windowText.startsWith(title) ? windowText.slice(title.length).trim() : windowText;
    return withoutTitle.slice(0, 280) || `${title} dataset from UCI Machine Learning Repository.`;
  }

  private extractRowsHint(windowText: string): string {
    const match = windowText.match(/([0-9][0-9,]*)\s+(?:instances|rows|records)/i);
    return match ? `${match[1]} rows` : 'See UCI dataset page';
  }

  private extractModality(windowText: string): string {
    const normalized = windowText.toLowerCase();
    if (normalized.includes('time-series') || normalized.includes('time series') || normalized.includes('sequential')) {
      return 'time series';
    }
    if (normalized.includes('text') || normalized.includes('document') || normalized.includes('language')) {
      return 'text corpus';
    }
    return 'tabular dataset';
  }
}
