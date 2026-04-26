import { Injectable } from '@nestjs/common';
import { uniqueKeepOrder } from '../../../common/text';
import type { DiscoveryContext } from '../../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  collapseWhitespace,
  connectorSearchMetadata,
  envNumber,
  fetchText,
  stripHtml,
} from './connector.utils';
import { datasetQueriesForSource, type DiscoveryPlan } from '../types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/collection-hit';

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
    const connectorMeta = connectorSearchMetadata('uci');
    const sourceQueries = datasetQueriesForSource(plan, 'uci');
    const queries = this.prioritizedQueries(sourceQueries, context);
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const perQueryLimit = Math.max(
      2,
      Math.min(envNumber(['COLLECTION_CONNECTOR_LIMIT_PER_SOURCE', 'DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE'], 20), 12),
    );
    const totalHitLimit = Math.max(4, Math.min(perQueryLimit * 2, 12));
    const enrichAttemptLimit = Math.max(6, perQueryLimit * 3);
    const seenIds = new Set<string>();

    for (const baseQuery of queries) {
      if (hits.length >= totalHitLimit) {
        break;
      }
      try {
        let count = 0;
        let structureIssue = false;
        const triedVariants: string[] = [];

        for (const query of this.queryVariants(baseQuery, context)) {
          triedVariants.push(query);
          const url = `https://archive.ics.uci.edu/datasets?search=${encodeURIComponent(query)}`;
          const html = await fetchText(url);
          const parsed = this.parseDatasetCards(html).slice(0, perQueryLimit * 3);

          if (parsed.length === 0) {
            if (!this.looksLikeUciSearchPage(html)) {
              structureIssue = true;
            }
            continue;
          }

          let enrichAttempts = 0;
          for (const item of parsed) {
            if (seenIds.has(item.slug)) {
              continue;
            }
            if (!this.isPotentiallyRelevantCard(item, context, plan)) {
              continue;
            }
            if (enrichAttempts >= enrichAttemptLimit) {
              break;
            }
            enrichAttempts += 1;
            const enriched = this.shouldEnrichCard(item, context) ? await this.enrichCard(item) : item;
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
              downloadUrl: enriched.sourceUrl,
              downloadMethod: 'source-page',
              downloadHint: `Open the UCI dataset page for ${enriched.slug} and use the data folder or download links.`,
              downloadReference: enriched.slug,
              retrievalHint: `Matched UCI search query: ${query}`,
              tags: [query, ...enriched.tags],
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
              connector: 'uci',
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
            seenIds.add(item.slug);
            count += 1;
            if (count >= perQueryLimit || hits.length >= totalHitLimit) {
              break;
            }
          }

          if (count > 0 || hits.length >= totalHitLimit) {
            break;
          }
        }

        debug.push({
          id: baseQuery,
          connector: 'uci',
          matchedQueries: [baseQuery],
          matchedTerms: triedVariants.slice(0, 6),
          status: structureIssue && count === 0 ? 'error' : 'ok',
          count,
          error:
            structureIssue && count === 0
              ? 'UCI search page format did not contain recognizable dataset entries.'
              : undefined,
        });
      } catch (error) {
        debug.push({
          id: baseQuery,
          connector: 'uci',
          matchedQueries: [baseQuery],
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

  private shouldEnrichCard(card: ParsedUciDatasetCard, context: DiscoveryContext): boolean {
    if (context.modality === 'text' || context.modalitySignals.includes('text')) {
      return false;
    }
    if (card.rowsHint !== 'See UCI dataset page' && card.description.length >= 80) {
      return false;
    }
    return true;
  }

  private parseDatasetCards(html: string): ParsedUciDatasetCard[] {
    const matches = [...html.matchAll(/href=['"]\/dataset\/(\d+)(?:\/[^'"]*)?['"][^>]*>([\s\S]*?)<\/a>/gi)];
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
      const cardStart = html.lastIndexOf('<', index);
      const window = html.slice(cardStart >= 0 ? cardStart : index, index + 1400);
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

  private looksLikeUciSearchPage(html: string): boolean {
    const normalized = html.toLowerCase();
    return (
      normalized.includes('uci machine learning repository') ||
      normalized.includes('/dataset/') ||
      normalized.includes('datasets - uci machine learning repository')
    );
  }

  private queryVariants(query: string, context: DiscoveryContext): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    const stableQueries = new Set([
      'text classification',
      'document classification',
      'authorship attribution',
      'spam',
      'clinc',
      'time series',
      'forecast',
      'forecasting',
      'stock',
    ]);
    if (stableQueries.has(normalizedQuery)) {
      return [query.trim()];
    }

    const variants = [query.trim()];
    const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length >= 3) {
      variants.push(tokens.slice(0, 3).join(' '));
    }
    if (tokens.length >= 2) {
      variants.push(tokens.slice(0, 2).join(' '));
    }
    if (tokens.length >= 1) {
      variants.push(tokens[0]);
    }
    if (context.modality === 'text' || context.modalitySignals.includes('text')) {
      variants.push('text classification', 'authorship attribution', 'spam', 'clinc', 'document classification');
    }
    if (context.taskSignals.includes('time-series-forecasting')) {
      variants.push('time series', 'forecast');
    }
    return uniqueKeepOrder(
      variants.filter((value) => {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
          return false;
        }
        if (normalized === 'text') {
          return false;
        }
        return normalized.length > 2;
      }),
    ).slice(0, 5);
  }

  private prioritizedQueries(sourceQueries: string[], context: DiscoveryContext): string[] {
    const prioritized = [...this.fallbackQueries(context)];
    for (const query of sourceQueries) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (
        normalized.includes('authorship') ||
        normalized.includes('text classification') ||
        normalized.includes('document classification') ||
        normalized.includes('spam') ||
        normalized.includes('clinc') ||
        normalized.includes('intent') ||
        normalized.includes('sentiment') ||
        normalized.includes('time series') ||
        normalized.includes('forecast')
      ) {
        prioritized.push(query);
      }
    }

    return uniqueKeepOrder(prioritized).slice(0, 4);
  }

  private fallbackQueries(context: DiscoveryContext): string[] {
    if (context.modality === 'text' || context.modalitySignals.includes('text')) {
      return ['text classification', 'authorship attribution', 'spam', 'document classification'];
    }
    if (context.taskSignals.includes('time-series-forecasting')) {
      return ['time series', 'forecasting', 'stock'];
    }
    return ['classification', 'dataset'];
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
    return this.evaluateRelevance(card, context, plan, false);
  }

  private isPotentiallyRelevantCard(
    card: ParsedUciDatasetCard,
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): boolean {
    return this.evaluateRelevance(card, context, plan, true);
  }

  private evaluateRelevance(
    card: ParsedUciDatasetCard,
    context: DiscoveryContext,
    plan: DiscoveryPlan,
    prefilter: boolean,
  ): boolean {
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

      if (highConfidenceCount === 0 && positiveCount < (prefilter ? 1 : 2)) {
        return false;
      }
      if (negativeCount > 0 && highConfidenceCount === 0 && !prefilter) {
        return false;
      }
      if (negativeCount >= (prefilter ? 3 : 2) && positiveCount < 3 && queryOverlap < 2) {
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
