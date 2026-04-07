import { Injectable } from '@nestjs/common';
import { uniqueKeepOrder } from '../../common/text';
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
        const parsed = this.parseDatasetCards(html).slice(0, perQueryLimit * 2);
        let count = 0;

        for (const item of parsed) {
          const enriched = await this.enrichCard(item);
          if (!this.isRelevantCard(enriched, context, plan)) {
            continue;
          }

          const entry = buildDatasetEntry({
            id: `uci:${enriched.slug}`,
            name: enriched.title,
            provider: 'UCI Machine Learning Repository',
            description: enriched.description,
            rowsHint: enriched.rowsHint,
            modality: enriched.modality,
            licenseHint: 'See UCI dataset page',
            sourceUrl: enriched.sourceUrl,
            retrievalHint: `Matched UCI search query: ${query}`,
            tags: [query, ...enriched.tags],
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
          if (count >= perQueryLimit) {
            break;
          }
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

  private async enrichCard(card: ParsedUciDatasetCard): Promise<ParsedUciDatasetCard> {
    try {
      const html = await fetchText(card.sourceUrl);
      const pageText = collapseWhitespace(stripHtml(html)).slice(0, 4000);
      const title = card.title;
      const description = this.extractDescription(pageText, title);
      const rowsHint = this.extractRowsHint(pageText);
      const modality = this.extractModality(pageText);
      const tags = uniqueKeepOrder([
        ...card.tags,
        ...pageText.split(/\s+/).filter(Boolean).slice(0, 80),
      ]).slice(0, 40);

      return {
        ...card,
        description: description.length > card.description.length ? description : card.description,
        rowsHint: rowsHint !== 'See UCI dataset page' ? rowsHint : card.rowsHint,
        modality,
        tags,
      };
    } catch {
      return card;
    }
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

  private isRelevantCard(card: ParsedUciDatasetCard, context: DiscoveryContext, plan: DiscoveryPlan): boolean {
    const titleAndDescription = `${card.title} ${card.description}`.toLowerCase();
    const combined = `${titleAndDescription} ${card.tags.join(' ')}`.toLowerCase();

    if (context.modality === 'text' || context.modalitySignals.includes('text')) {
      const strongTextSignals = [
        'text',
        'language',
        'document',
        'corpus',
        'authorship',
        'author',
        'essay',
        'review',
        'article',
        'prompt',
        'response',
        'question',
        'answer',
        'news',
        'sentiment',
        'spam',
        'chat',
        'nlp',
        'intent',
        'clinc',
      ];
      const highConfidenceTextSignals = [
        'authorship',
        'author',
        'essay',
        'review',
        'article',
        'prompt',
        'response',
        'question',
        'answer',
        'chat',
        'nlp',
        'intent',
        'clinc',
        'corpus',
        'document',
      ];
      const negativeTextSignals = [
        'clinical',
        'patient',
        'surgery',
        'caesarian',
        'cancer',
        'tumor',
        'hospital',
        'drug',
        'diagnosis',
        'thoracic',
        'hepatitis',
        'biomedical',
        'image',
        'vision',
        'pixel',
        'cifar',
        'imagenet',
        'object detection',
        'segmentation',
        'caesarean',
      ];

      const positiveCount = strongTextSignals.filter((signal) => combined.includes(signal)).length;
      const highConfidenceCount = highConfidenceTextSignals.filter((signal) =>
        titleAndDescription.includes(signal),
      ).length;
      const negativeCount = negativeTextSignals.filter((signal) => combined.includes(signal)).length;
      const queryOverlap = plan.mustInclude.filter((term) => combined.includes(term.toLowerCase())).length;

      if (highConfidenceCount === 0 && positiveCount < 2) {
        return false;
      }
      if (negativeCount > 0 && highConfidenceCount === 0) {
        return false;
      }
      if (negativeCount >= 2 && positiveCount < 3 && queryOverlap < 2) {
        return false;
      }
    }

    if (context.taskSignals.includes('time-series-forecasting')) {
      const hasForecastSignal =
        combined.includes('time series') ||
        combined.includes('forecast') ||
        combined.includes('stock') ||
        combined.includes('price') ||
        combined.includes('market');
      if (!hasForecastSignal) {
        return false;
      }
    }

    return true;
  }
}
