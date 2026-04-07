import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../common/contracts';
import { tokenize, uniqueKeepOrder } from '../common/text';
import type {
  DatasetDiscoverySource,
  DiscoveryPlan,
  KnowledgeDiscoverySource,
} from './types/discovery-plan';

type SourceAwareQueries<T extends string> = Record<T, string[]>;

const genericStopwords = new Set([
  'dataset',
  'benchmark',
  'corpus',
  'with',
  'and',
  'metadata',
  'using',
  'for',
  'the',
  'based',
  'records',
  'record',
]);

@Injectable()
export class DiscoveryQueryPlannerService {
  buildPlan(context: DiscoveryContext): DiscoveryPlan {
    const mustAvoid = this.buildNegativeHints(context);
    const mustInclude = this.buildPositiveHints(context);

    const canonicalDatasetQueries = this.buildCanonicalDatasetQueries(context, mustAvoid);
    const fallbackDatasetQueries = this.buildFallbackDatasetQueries(context, mustAvoid);
    const canonicalKnowledgeQueries = this.buildCanonicalKnowledgeQueries(context, mustAvoid);
    const fallbackKnowledgeQueries = this.buildFallbackKnowledgeQueries(context, mustAvoid);

    const datasetSourceQueries = this.buildDatasetSourceQueries(
      context,
      canonicalDatasetQueries,
      fallbackDatasetQueries,
    );
    const knowledgeSourceQueries = this.buildKnowledgeSourceQueries(
      context,
      canonicalKnowledgeQueries,
      fallbackKnowledgeQueries,
    );

    return {
      selectedDomainIds: [...context.selectedDomainIds],
      taskSignals: [...context.taskSignals],
      modalitySignals: [...context.modalitySignals],
      canonicalKnowledgeQueries,
      fallbackKnowledgeQueries,
      knowledgeQueries: uniqueKeepOrder([
        ...canonicalKnowledgeQueries,
        ...fallbackKnowledgeQueries,
      ]).slice(0, 10),
      canonicalDatasetQueries,
      fallbackDatasetQueries,
      datasetQueries: uniqueKeepOrder([
        ...canonicalDatasetQueries,
        ...fallbackDatasetQueries,
      ]).slice(0, 10),
      datasetSourceQueries,
      knowledgeSourceQueries,
      mustInclude,
      mustAvoid,
    };
  }

  private buildPositiveHints(context: DiscoveryContext): string[] {
    return uniqueKeepOrder(
      [
        ...context.expandedKeywords,
        ...context.labelHints,
        ...context.textColumns.slice(0, 4),
        ...context.featureColumns.slice(0, 8),
        ...context.taskSignals,
        ...context.modalitySignals,
      ]
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => this.canonicalizePhrase(value)),
    ).slice(0, 20);
  }

  private buildCanonicalDatasetQueries(context: DiscoveryContext, mustAvoid: string[]): string[] {
    if (context.modalitySignals.includes('text')) {
      return this.sanitizeQueries(
        [
          'ai generated text detection',
          'human vs ai text classification',
          'generated content detection dataset',
          'authorship attribution dataset',
          'text authenticity classification dataset',
        ],
        mustAvoid,
      );
    }

    if (
      context.selectedDomainIds.includes('dom-finance') &&
      context.taskSignals.includes('time-series-forecasting')
    ) {
      return this.sanitizeQueries(
        [
          'financial time series forecasting dataset',
          'stock price prediction dataset',
          'ohlcv market dataset',
          'technical indicator dataset',
        ],
        mustAvoid,
      );
    }

    return this.sanitizeQueries(
      uniqueKeepOrder(
        context.generatedQueries
          .map((query) => this.canonicalizePhrase(query))
          .filter(Boolean),
      ).slice(0, 5),
      mustAvoid,
    );
  }

  private buildFallbackDatasetQueries(context: DiscoveryContext, mustAvoid: string[]): string[] {
    const fallback = uniqueKeepOrder([
      ...context.generatedQueries.map((query) => this.compressQuery(query)),
      ...context.featureColumns.slice(0, 3).map((value) => this.canonicalizePhrase(value)),
      ...context.taskSignals.map((value) => this.canonicalizePhrase(value)),
    ]).filter(Boolean);

    return this.sanitizeQueries(fallback, mustAvoid).slice(0, 8);
  }

  private buildCanonicalKnowledgeQueries(context: DiscoveryContext, mustAvoid: string[]): string[] {
    if (context.modalitySignals.includes('text')) {
      return this.sanitizeQueries(
        [
          'generated text detection paper',
          'authorship attribution methods',
          'text provenance guideline',
          'human vs machine text benchmark',
          'content authenticity overview',
        ],
        mustAvoid,
      );
    }

    if (
      context.selectedDomainIds.includes('dom-finance') &&
      context.taskSignals.includes('time-series-forecasting')
    ) {
      return this.sanitizeQueries(
        [
          'financial time series forecasting paper',
          'technical indicator leakage guideline',
          'market prediction benchmark overview',
        ],
        mustAvoid,
      );
    }

    return this.sanitizeQueries(
      uniqueKeepOrder(
        context.generatedQueries.map((query) => `${this.canonicalizePhrase(query)} paper`),
      ),
      mustAvoid,
    ).slice(0, 6);
  }

  private buildFallbackKnowledgeQueries(context: DiscoveryContext, mustAvoid: string[]): string[] {
    return this.sanitizeQueries(
      uniqueKeepOrder([
        ...context.generatedQueries.map((query) => `${this.compressQuery(query)} overview`),
        ...context.taskSignals.map((signal) => `${signal} guideline`),
      ]),
      mustAvoid,
    ).slice(0, 8);
  }

  private buildDatasetSourceQueries(
    context: DiscoveryContext,
    canonical: string[],
    fallback: string[],
  ): SourceAwareQueries<DatasetDiscoverySource> {
    const shortTextQueries = context.modalitySignals.includes('text')
      ? ['ai text detection', 'authorship attribution', 'text classification', 'spam', 'intent']
      : [];
    const financeShortQueries =
      context.taskSignals.includes('time-series-forecasting') && context.selectedDomainIds.includes('dom-finance')
        ? ['stock', 'ohlcv', 'forecasting', 'market prediction']
        : [];

    return {
      'seed-catalog': canonical,
      huggingface: uniqueKeepOrder([...canonical, ...shortTextQueries, ...fallback]).slice(0, 8),
      openml: uniqueKeepOrder([
        ...shortTextQueries,
        ...financeShortQueries,
        ...fallback.map((query) => this.compressQuery(query)),
      ]).slice(0, 6),
      uci: uniqueKeepOrder([
        ...shortTextQueries,
        context.modalitySignals.includes('text') ? 'clinc150' : '',
        ...fallback.map((query) => this.compressQuery(query)),
      ]).filter(Boolean).slice(0, 6),
      kaggle: uniqueKeepOrder([
        ...canonical.map((query) => `${query} dataset`),
        ...fallback,
      ]).slice(0, 8),
    };
  }

  private buildKnowledgeSourceQueries(
    context: DiscoveryContext,
    canonical: string[],
    fallback: string[],
  ): SourceAwareQueries<KnowledgeDiscoverySource> {
    const crossrefFriendly = uniqueKeepOrder([
      ...canonical.map((query) => this.compressQuery(query)),
      ...fallback.map((query) => this.compressQuery(query)),
    ]).slice(0, 8);

    return {
      'seed-catalog': canonical,
      serpapi: uniqueKeepOrder([...canonical, ...fallback]).slice(0, 8),
      crossref: uniqueKeepOrder([
        ...crossrefFriendly.map((query) => `${query} paper`),
        ...crossrefFriendly.map((query) => `${query} benchmark`),
      ]).slice(0, 8),
    };
  }

  private buildNegativeHints(context: DiscoveryContext): string[] {
    if (context.modalitySignals.includes('text')) {
      return uniqueKeepOrder([
        'clinical',
        'patient',
        'fraud',
        'transaction',
        'sensor',
        'turbofan',
        'biomarker',
        'specimen',
      ]);
    }

    if (
      context.selectedDomainIds.includes('dom-finance') &&
      context.taskSignals.includes('time-series-forecasting')
    ) {
      return uniqueKeepOrder([
        'patient',
        'clinical',
        'essay',
        'authorship',
        'generated text',
        'fraud',
        'chargeback',
      ]);
    }

    if (context.selectedDomainIds.includes('dom-medical')) {
      return uniqueKeepOrder([
        'authorship',
        'essay',
        'generated text',
        'fraud',
      ]);
    }

    return [];
  }

  private sanitizeQueries(queries: string[], mustAvoid: string[]): string[] {
    const blockedTokens = new Set(tokenize(mustAvoid.join(' ')));
    return uniqueKeepOrder(
      queries
        .map((query) => this.canonicalizePhrase(query))
        .filter(Boolean)
        .map((query) => ({
          original: query,
          sanitized: tokenize(query)
            .filter((token) => !blockedTokens.has(token))
            .join(' '),
        }))
        .map((item) => item.sanitized || item.original)
        .map((query) => query.trim())
        .filter((query) => query.length >= 3),
    );
  }

  private canonicalizePhrase(value: string): string {
    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\b(benchmark|dataset|corpus)\b/gi, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private compressQuery(query: string): string {
    return uniqueKeepOrder(tokenize(query).filter((token) => !genericStopwords.has(token)))
      .slice(0, 4)
      .join(' ');
  }
}
