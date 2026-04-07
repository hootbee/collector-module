import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../common/contracts';
import { tokenize, uniqueKeepOrder } from '../common/text';
import type { DiscoveryPlan } from './types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoveryRankingOutcome,
  KnowledgeDiscoveryHit,
  RankedDiscoveryHit,
} from './types/discovery-hit';

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
export class DiscoveryRankingService {
  rankKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): DiscoveryRankingOutcome<KnowledgeDiscoveryHit> {
    return this.finalizeCandidates(hits.map((hit) => this.rankHit(hit, context, plan)));
  }

  rankDatasetHits(
    hits: DatasetDiscoveryHit[],
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): DiscoveryRankingOutcome<DatasetDiscoveryHit> {
    return this.finalizeCandidates(hits.map((hit) => this.rankHit(hit, context, plan)));
  }

  private rankHit<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    hit: T,
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): RankedDiscoveryHit<T> {
    const keywords = new Set(
      tokenize(
        plan.mustInclude.join(' '),
        plan.knowledgeQueries.join(' '),
        plan.datasetQueries.join(' '),
        context.featureColumns.join(' '),
        context.textColumns.join(' '),
        context.labelHints.join(' '),
      ),
    );
    const textTokens = new Set(tokenize(hit.text));
    const tagTokens = new Set(tokenize(hit.tags.join(' ')));
    const selectedDomainSet = new Set(context.selectedDomainIds);
    const selectedTaskSet = new Set(context.taskSignals);
    const selectedModalitySet = new Set(context.modalitySignals);
    const matchedKeywords = uniqueKeepOrder(
      [
        ...hit.tags.filter((tag) => keywords.has(tag.toLowerCase())),
        ...[...keywords].filter((token) => textTokens.has(token) || tagTokens.has(token)),
      ].slice(0, 8),
    );

    let score = 0;
    const reasons: string[] = [];

    const selectedDomainMatches = hit.domainIds.filter((domainId) => selectedDomainSet.has(domainId));
    if (selectedDomainMatches.length > 0) {
      score += selectedDomainMatches.length * 8;
      reasons.push(`selected domain match: ${selectedDomainMatches.join(', ')}`);
    } else if (selectedDomainSet.size > 0 && hit.domainIds.length > 0) {
      score -= 5.5;
      reasons.push('selected domain mismatch penalty');
    }

    const selectedTaskMatches = hit.taskSignals.filter((taskSignal) => selectedTaskSet.has(taskSignal));
    if (selectedTaskMatches.length > 0) {
      score += selectedTaskMatches.length * 6.5;
      reasons.push(`task signal match: ${selectedTaskMatches.join(', ')}`);
    } else if (selectedTaskSet.size > 0 && hit.taskSignals.length > 0) {
      score -= 2.5;
      reasons.push('task mismatch penalty');
    }

    const selectedModalityMatches = hit.modalitySignals.filter((signal) => selectedModalitySet.has(signal));
    if (selectedModalityMatches.length > 0) {
      score += selectedModalityMatches.length * 5;
      reasons.push(`modality signal match: ${selectedModalityMatches.join(', ')}`);
    } else if (selectedModalitySet.size > 0 && hit.modalitySignals.length > 0) {
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

    if (context.modality === hit.modality) {
      score += 3;
      reasons.push(`modality match=${hit.modality}`);
    } else if (context.modality === 'text' && hit.modality === 'text') {
      score += 3;
    } else if (context.modality === 'text' && hit.modality === 'table') {
      score -= 5;
      reasons.push('text dataset penalty for table-centric candidate');
    }

    const negativeHits = hit.negativeTags.filter(
      (tag) => keywords.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase()),
    );
    const planNegativeHits = plan.mustAvoid.filter(
      (tag) => tagTokens.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase()),
    );
    if (negativeHits.length > 0 || planNegativeHits.length > 0) {
      const combined = uniqueKeepOrder([...negativeHits, ...planNegativeHits]);
      score -= combined.length * 3;
      reasons.push(`negative tag penalty: ${combined.join(', ')}`);
    }

    const textDomainSelected = context.selectedDomainIds.some((domainId) => textFirstDomainIds.has(domainId));
    const candidateTextAligned =
      hit.modality === 'text' || hit.domainIds.some((domainId) => textFirstDomainIds.has(domainId));
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
      } else if (hit.taskSignals.includes('anomaly-detection')) {
        score -= 4.5;
        reasons.push('forecasting context penalty for anomaly-only candidate');
      }
    }

    return {
      hit,
      score,
      matchedKeywords,
      matchedReason: reasons.join(' | ') || 'weak overlap only',
      filteredOutReason: score <= 0 ? 'score <= 0 after domain/modality filtering' : null,
    };
  }

  private finalizeCandidates<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    candidates: RankedDiscoveryHit<T>[],
  ): DiscoveryRankingOutcome<T> {
    const positiveCandidates = candidates
      .filter((item) => item.filteredOutReason == null)
      .sort((left, right) => right.score - left.score || left.hit.id.localeCompare(right.hit.id));

    if (positiveCandidates.length === 0) {
      return {
        items: [],
        debug: candidates
          .sort((left, right) => right.score - left.score || left.hit.id.localeCompare(right.hit.id))
          .map((item) => ({
            id: item.hit.id,
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
    const selectedIds = new Set(items.map((item) => item.hit.id));

    return {
      items,
      debug: candidates
        .sort((left, right) => right.score - left.score || left.hit.id.localeCompare(right.hit.id))
        .map((item) => ({
          id: item.hit.id,
          score: item.score,
          matchedKeywords: item.matchedKeywords,
          matchedReason: item.matchedReason,
          filteredOutReason:
            item.filteredOutReason ??
            (selectedIds.has(item.hit.id) ? null : `below ranking cutoff (${minimumScore.toFixed(2)})`),
        })),
    };
  }
}
