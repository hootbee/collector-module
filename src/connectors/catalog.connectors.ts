import { Injectable } from '@nestjs/common';
import { datasetCatalog, knowledgeCatalog } from '../common/catalog';
import type {
  DatasetCatalogEntry,
  DiscoveryContext,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
  KnowledgeCatalogEntry,
} from '../common/contracts';
import { tokenize, uniqueKeepOrder } from '../common/text';

type RankedCandidate<T> = {
  id: string;
  score: number;
  matchedKeywords: string[];
  matchedReason: string;
  filteredOutReason: string | null;
  value: T;
};

type SearchOutcome<T> = {
  items: T[];
  debug: Array<{
    id: string;
    score: number;
    matchedKeywords: string[];
    matchedReason: string;
    filteredOutReason: string | null;
  }>;
};

const textFirstDomainIds = new Set([
  'dom-nlp',
  'dom-text-classification',
  'dom-content-authenticity',
  'dom-ai-generated-content-detection',
  'dom-authorship-attribution',
  'dom-media-forensics',
  'dom-misinformation-provenance',
  'dom-education-writing-analysis',
]);

@Injectable()
export class CatalogConnectorsService {
  searchKnowledge(context: DiscoveryContext): SearchOutcome<ExternalKnowledgeItem> {
    const candidates = knowledgeCatalog.map((item) => this.scoreKnowledgeItem(item, context));
    const ranked = this.finalizeCandidates(candidates);

    return {
      items: ranked.items.map((item) => item.value),
      debug: ranked.debug,
    };
  }

  searchDatasets(context: DiscoveryContext): SearchOutcome<ExternalDatasetItem> {
    const candidates = datasetCatalog.map((item) => this.scoreDatasetItem(item, context));
    const ranked = this.finalizeCandidates(candidates);

    return {
      items: ranked.items.map((item) => item.value),
      debug: ranked.debug,
    };
  }

  private scoreKnowledgeItem(
    item: KnowledgeCatalogEntry,
    context: DiscoveryContext,
  ): RankedCandidate<ExternalKnowledgeItem> {
    const ranking = this.rankCatalogItem(
      {
        id: item.id,
        text: `${item.title} ${item.summary} ${item.source} ${item.publisher ?? ''}`,
        tags: item.tags,
        domainIds: item.domainIds ?? [],
        taskSignals: item.taskSignals ?? [],
        modalitySignals: item.modalitySignals ?? [],
        modality: item.modality ?? 'table',
        negativeTags: item.negativeTags ?? [],
      },
      context,
    );

    return {
      ...ranking,
      value: {
        id: item.id,
        title: item.title,
        source: item.source,
        summary: item.summary,
        kind: item.kind,
        matchedKeywords: ranking.matchedKeywords.slice(0, 6),
        sourceUrl: item.sourceUrl,
        publisher: item.publisher,
        retrievalHint: item.retrievalHint,
        score: Number(ranking.score.toFixed(3)),
        matchedReason: ranking.matchedReason,
      },
    };
  }

  private scoreDatasetItem(
    item: DatasetCatalogEntry,
    context: DiscoveryContext,
  ): RankedCandidate<ExternalDatasetItem> {
    const ranking = this.rankCatalogItem(
      {
        id: item.id,
        text: `${item.name} ${item.description} ${item.provider} ${item.providerDetail ?? ''} ${item.modality}`,
        tags: item.tags,
        domainIds: item.domainIds ?? [],
        taskSignals: item.taskSignals ?? [],
        modalitySignals: item.modalitySignals ?? [],
        modality: item.modalityType ?? 'table',
        negativeTags: item.negativeTags ?? [],
      },
      context,
    );

    return {
      ...ranking,
      value: {
        id: item.id,
        name: item.name,
        provider: item.provider,
        description: item.description,
        rowsHint: item.rowsHint,
        modality: item.modality,
        licenseHint: item.licenseHint,
        matchedKeywords: ranking.matchedKeywords.slice(0, 6),
        sourceUrl: item.sourceUrl,
        providerDetail: item.providerDetail,
        publisher: item.publisher,
        retrievalHint: item.retrievalHint,
        score: Number(ranking.score.toFixed(3)),
        matchedReason: ranking.matchedReason,
      },
    };
  }

  private rankCatalogItem(
    item: {
      id: string;
      text: string;
      tags: string[];
      domainIds: string[];
      taskSignals: DiscoveryContext['taskSignals'];
      modalitySignals: DiscoveryContext['modalitySignals'];
      modality: 'text' | 'table' | 'hybrid';
      negativeTags: string[];
    },
    context: DiscoveryContext,
  ): Omit<RankedCandidate<never>, 'value'> {
    const keywords = new Set(
      tokenize(
        context.expandedKeywords.join(' '),
        context.generatedQueries.join(' '),
        context.featureColumns.join(' '),
        context.textColumns.join(' '),
        context.labelHints.join(' '),
      ),
    );
    const textTokens = new Set(tokenize(item.text));
    const tagTokens = new Set(tokenize(item.tags.join(' ')));
    const selectedDomainSet = new Set(context.selectedDomainIds);
    const selectedTaskSet = new Set(context.taskSignals);
    const selectedModalitySet = new Set(context.modalitySignals);
    const matchedKeywords = uniqueKeepOrder(
      [
        ...item.tags.filter((tag) => keywords.has(tag.toLowerCase())),
        ...[...keywords].filter((token) => textTokens.has(token) || tagTokens.has(token)),
      ].slice(0, 8),
    );

    let score = 0;
    const reasons: string[] = [];

    const selectedDomainMatches = item.domainIds.filter((domainId) => selectedDomainSet.has(domainId));
    if (selectedDomainMatches.length > 0) {
      score += selectedDomainMatches.length * 8;
      reasons.push(`selected domain match: ${selectedDomainMatches.join(', ')}`);
    } else if (selectedDomainSet.size > 0 && item.domainIds.length > 0) {
      score -= 5.5;
      reasons.push('selected domain mismatch penalty');
    }

    const selectedTaskMatches = item.taskSignals.filter((taskSignal) => selectedTaskSet.has(taskSignal));
    if (selectedTaskMatches.length > 0) {
      score += selectedTaskMatches.length * 6.5;
      reasons.push(`task signal match: ${selectedTaskMatches.join(', ')}`);
    } else if (selectedTaskSet.size > 0 && item.taskSignals.length > 0) {
      score -= 2.5;
      reasons.push('task mismatch penalty');
    }

    const selectedModalityMatches = item.modalitySignals.filter((signal) => selectedModalitySet.has(signal));
    if (selectedModalityMatches.length > 0) {
      score += selectedModalityMatches.length * 5;
      reasons.push(`modality signal match: ${selectedModalityMatches.join(', ')}`);
    } else if (selectedModalitySet.size > 0 && item.modalitySignals.length > 0) {
      score -= 2;
      reasons.push('modality signal mismatch penalty');
    }

    const keywordTagOverlap = [...keywords].filter((token) => tagTokens.has(token)).length;
    const keywordTextOverlap = [...keywords].filter((token) => textTokens.has(token)).length;
    if (keywordTagOverlap > 0 || keywordTextOverlap > 0) {
      score += keywordTagOverlap * 4 + keywordTextOverlap * 1.5;
      reasons.push(`keyword overlap tags=${keywordTagOverlap}, text=${keywordTextOverlap}`);
    }

    if (
      selectedDomainMatches.length === 0 &&
      selectedDomainSet.size > 0 &&
      keywordTagOverlap + keywordTextOverlap < 4
    ) {
      score -= 6;
      reasons.push('weak overlap penalty under selected-domain mismatch');
    }

    const descriptionOverlap = [...tokenize(context.dataset.description)].filter((token) => textTokens.has(token)).length;
    if (descriptionOverlap > 0) {
      score += descriptionOverlap * 1.6;
      reasons.push(`description overlap=${descriptionOverlap}`);
    }

    const labelOverlap = [...tokenize(context.labelHints.join(' '))].filter(
      (token) => textTokens.has(token) || tagTokens.has(token),
    ).length;
    if (labelOverlap > 0) {
      score += labelOverlap * 2.4;
      reasons.push(`label compatibility=${labelOverlap}`);
    }

    if (context.modality === item.modality) {
      score += 3;
      reasons.push(`modality match=${item.modality}`);
    } else if (context.modality === 'text' && item.modality === 'text') {
      score += 3;
    } else if (context.modality === 'text' && item.modality === 'table') {
      score -= 5;
      reasons.push('text dataset penalty for table-centric candidate');
    }

    const negativeHits = item.negativeTags.filter((tag) => keywords.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase()));
    if (negativeHits.length > 0) {
      score -= negativeHits.length * 3;
      reasons.push(`negative tag penalty: ${negativeHits.join(', ')}`);
    }

    const textDomainSelected = context.selectedDomainIds.some((domainId) => textFirstDomainIds.has(domainId));
    const candidateTextAligned =
      item.modality === 'text' || item.domainIds.some((domainId) => textFirstDomainIds.has(domainId));

    if (context.modality === 'text' || textDomainSelected) {
      if (candidateTextAligned) {
        score += 3.5;
      } else {
        score -= 6;
        reasons.push('text-first ranking penalty');
      }
    }

    if (context.taskSignals.includes('time-series-forecasting')) {
      const forecastTokens = new Set(tokenize('forecasting market ohlcv price history volatility macd rsi'));
      const forecastOverlap = [...forecastTokens].filter((token) => tagTokens.has(token) || textTokens.has(token)).length;
      if (forecastOverlap > 0) {
        score += forecastOverlap * 2.2;
        reasons.push(`forecast overlap=${forecastOverlap}`);
      } else if (item.taskSignals.includes('anomaly-detection')) {
        score -= 4.5;
        reasons.push('forecasting context penalty for anomaly-only candidate');
      }
    }

    const filteredOutReason =
      score <= 0
        ? 'score <= 0 after domain/modality filtering'
        : null;

    return {
      id: item.id,
      score,
      matchedKeywords,
      matchedReason: reasons.join(' | ') || 'weak overlap only',
      filteredOutReason,
    };
  }

  private finalizeCandidates<T>(candidates: RankedCandidate<T>[]): {
    items: RankedCandidate<T>[];
    debug: Array<{
      id: string;
      score: number;
      matchedKeywords: string[];
      matchedReason: string;
      filteredOutReason: string | null;
    }>;
  } {
    const positiveCandidates = candidates
      .filter((item) => item.filteredOutReason == null)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    if (positiveCandidates.length === 0) {
      return {
        items: [],
        debug: candidates
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
          .map((item) => ({
            id: item.id,
            score: item.score,
            matchedKeywords: item.matchedKeywords,
            matchedReason: item.matchedReason,
            filteredOutReason: item.filteredOutReason,
          })),
      };
    }

    const topScore = positiveCandidates[0].score;
    const minimumScore = topScore >= 10 ? Math.max(4, topScore * 0.25) : 2.5;
    const items = positiveCandidates
      .filter((item, index) => index === 0 || item.score >= minimumScore)
      .slice(0, 8);
    const selectedIds = new Set(items.map((item) => item.id));

    return {
      items,
      debug: candidates
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .map((item) => ({
          id: item.id,
          score: item.score,
          matchedKeywords: item.matchedKeywords,
          matchedReason: item.matchedReason,
          filteredOutReason:
            item.filteredOutReason ??
            (selectedIds.has(item.id) ? null : `below ranking cutoff (${minimumScore.toFixed(2)})`),
        })),
    };
  }
}
