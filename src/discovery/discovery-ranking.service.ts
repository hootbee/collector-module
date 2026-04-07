import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../common/contracts';
import { tokenize, uniqueKeepOrder } from '../common/text';
import {
  connectorMetadata,
  rankingWeights,
} from './discovery-ranking.config';
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
    return this.finalizeCandidates(hits.map((hit) => this.rankHit(hit, context, plan)), 'knowledge');
  }

  rankDatasetHits(
    hits: DatasetDiscoveryHit[],
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): DiscoveryRankingOutcome<DatasetDiscoveryHit> {
    return this.finalizeCandidates(hits.map((hit) => this.rankHit(hit, context, plan)), 'dataset');
  }

  private rankHit<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    hit: T,
    context: DiscoveryContext,
    plan: DiscoveryPlan,
  ): RankedDiscoveryHit<T> {
    const connector = connectorMetadata(hit.connector);
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
    const scoreBreakdown: Record<string, number> = {};
    const apply = (key: string, delta: number, reason?: string) => {
      if (delta === 0) {
        return;
      }
      score += delta;
      scoreBreakdown[key] = Number(((scoreBreakdown[key] ?? 0) + delta).toFixed(3));
      if (reason) {
        reasons.push(reason);
      }
    };

    const selectedDomainMatches = hit.domainIds.filter((domainId) => selectedDomainSet.has(domainId));
    if (selectedDomainMatches.length > 0) {
      apply(
        'domainMatch',
        selectedDomainMatches.length * rankingWeights.domainMatch,
        `selected domain match: ${selectedDomainMatches.join(', ')}`,
      );
    } else if (selectedDomainSet.size > 0 && hit.domainIds.length > 0) {
      apply('crossDomainPenalty', -rankingWeights.crossDomainPenalty, 'selected domain mismatch penalty');
    }

    const selectedTaskMatches = hit.taskSignals.filter((taskSignal) => selectedTaskSet.has(taskSignal));
    if (selectedTaskMatches.length > 0) {
      apply(
        'taskMatch',
        selectedTaskMatches.length * rankingWeights.taskMatch,
        `task signal match: ${selectedTaskMatches.join(', ')}`,
      );
    } else if (selectedTaskSet.size > 0 && hit.taskSignals.length > 0) {
      apply('taskMismatch', -rankingWeights.taskMismatchPenalty, 'task mismatch penalty');
    }

    const selectedModalityMatches = hit.modalitySignals.filter((signal) => selectedModalitySet.has(signal));
    if (selectedModalityMatches.length > 0) {
      apply(
        'modalityMatch',
        selectedModalityMatches.length * rankingWeights.modalityMatch,
        `modality signal match: ${selectedModalityMatches.join(', ')}`,
      );
    } else if (selectedModalitySet.size > 0 && hit.modalitySignals.length > 0) {
      apply('modalityMismatch', -rankingWeights.modalityMismatchPenalty, 'modality signal mismatch penalty');
    }

    const keywordTagOverlap = [...keywords].filter((token) => tagTokens.has(token)).length;
    const keywordTextOverlap = [...keywords].filter((token) => textTokens.has(token)).length;
    if (keywordTagOverlap > 0 || keywordTextOverlap > 0) {
      apply(
        'keywordOverlap',
        keywordTagOverlap * rankingWeights.keywordTagOverlap +
          keywordTextOverlap * rankingWeights.keywordTextOverlap,
        `keyword overlap tags=${keywordTagOverlap}, text=${keywordTextOverlap}`,
      );
    }

    const mustIncludeHits = plan.mustInclude.filter(
      (term) => tagTokens.has(term.toLowerCase()) || textTokens.has(term.toLowerCase()),
    ).length;
    if (mustIncludeHits > 0) {
      apply('mustInclude', mustIncludeHits * rankingWeights.mustIncludeBonus, `mustInclude hits=${mustIncludeHits}`);
    }

    if (
      selectedDomainMatches.length === 0 &&
      selectedDomainSet.size > 0 &&
      keywordTagOverlap + keywordTextOverlap < 4
    ) {
      apply('weakOverlapPenalty', -rankingWeights.weakOverlapPenalty, 'weak overlap penalty under selected-domain mismatch');
    }

    const descriptionOverlap = [...tokenize(context.dataset.description)].filter((token) => textTokens.has(token)).length;
    if (descriptionOverlap > 0) {
      apply(
        'descriptionOverlap',
        descriptionOverlap * rankingWeights.descriptionOverlap,
        `description overlap=${descriptionOverlap}`,
      );
    }

    const labelOverlap = [...tokenize(context.labelHints.join(' '))].filter(
      (token) => textTokens.has(token) || tagTokens.has(token),
    ).length;
    if (labelOverlap > 0) {
      apply('labelOverlap', labelOverlap * rankingWeights.labelOverlap, `label compatibility=${labelOverlap}`);
    }

    if (context.modality === hit.modality) {
      apply('exactModality', rankingWeights.exactModalityBonus, `modality match=${hit.modality}`);
    } else if (context.modality === 'text' && hit.modality === 'table') {
      apply('textAgainstTable', -rankingWeights.textAgainstTablePenalty, 'text dataset penalty for table-centric candidate');
    }

    const negativeHits = hit.negativeTags.filter(
      (tag) => keywords.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase()),
    );
    const planNegativeHits = plan.mustAvoid.filter(
      (tag) => tagTokens.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase()),
    );
    if (negativeHits.length > 0 || planNegativeHits.length > 0) {
      const combined = uniqueKeepOrder([...negativeHits, ...planNegativeHits]);
      apply(
        'negativePenalty',
        -combined.length * rankingWeights.negativePenalty,
        `negative tag penalty: ${combined.join(', ')}`,
      );
    }

    const explicitMustAvoidHits = plan.mustAvoid.filter((term) =>
      hit.title.toLowerCase().includes(term.toLowerCase()) || hit.text.toLowerCase().includes(term.toLowerCase()),
    );
    if (explicitMustAvoidHits.length > 0) {
      apply(
        'mustAvoidPenalty',
        -explicitMustAvoidHits.length * rankingWeights.mustAvoidPenalty,
        `mustAvoid penalty: ${explicitMustAvoidHits.join(', ')}`,
      );
    }

    const textDomainSelected = context.selectedDomainIds.some((domainId) => textFirstDomainIds.has(domainId));
    const candidateTextAligned =
      hit.modality === 'text' || hit.domainIds.some((domainId) => textFirstDomainIds.has(domainId));
    if (context.modality === 'text' || textDomainSelected) {
      if (candidateTextAligned) {
        apply('textFirstBonus', rankingWeights.textFirstBonus);
      } else {
        apply('textFirstPenalty', -rankingWeights.textFirstPenalty, 'text-first ranking penalty');
      }
    }

    if (context.taskSignals.includes('time-series-forecasting')) {
      const forecastTokens = new Set(tokenize('forecasting market ohlcv price history volatility macd rsi'));
      const forecastOverlap = [...forecastTokens].filter((token) => tagTokens.has(token) || textTokens.has(token)).length;
      if (forecastOverlap > 0) {
        apply('forecastOverlap', forecastOverlap * rankingWeights.forecastOverlap, `forecast overlap=${forecastOverlap}`);
      } else if (hit.taskSignals.includes('anomaly-detection')) {
        apply('forecastPenalty', -rankingWeights.anomalyInForecastPenalty, 'forecasting context penalty for anomaly-only candidate');
      }
    }

    apply('sourceReliability', connector.reliability * rankingWeights.sourceReliabilityMultiplier);
    apply('sourcePriority', connector.priority * rankingWeights.sourcePriorityMultiplier);

    if (typeof hit.llmRelevance === 'number' && Number.isFinite(hit.llmRelevance)) {
      apply('llmRelevance', hit.llmRelevance * rankingWeights.llmRelevanceMultiplier);
    }

    return {
      hit,
      score,
      matchedKeywords,
      matchedReason: reasons.join(' | ') || 'weak overlap only',
      filteredOutReason: score <= 0 ? 'score <= 0 after domain/modality filtering' : null,
      scoreBreakdown,
    };
  }

  private finalizeCandidates<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(
    candidates: RankedDiscoveryHit<T>[],
    kind: 'knowledge' | 'dataset',
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
            scoreBreakdown: item.scoreBreakdown,
            matchedKeywords: item.matchedKeywords,
            matchedReason: item.matchedReason,
            filteredOutReason: item.filteredOutReason,
          })),
      };
    }

    const topScore = positiveCandidates[0].score;
    const minimumScore = topScore >= 10 ? Math.max(5, topScore * 0.25) : 3;
    const selected: RankedDiscoveryHit<T>[] = [];
    const seen = new Set<string>();
    const connectorCounts = new Map<string, number>();

    for (const item of positiveCandidates) {
      if (item.score < minimumScore && selected.length > 0) {
        continue;
      }

      const metadata = connectorMetadata(item.hit.connector);
      const connectorLimit = kind === 'dataset' ? metadata.datasetLimit : metadata.knowledgeLimit;
      const usedCount = connectorCounts.get(item.hit.connector) ?? 0;
      if (connectorLimit > 0 && usedCount >= connectorLimit) {
        continue;
      }

      const dedupeKeys = this.dedupeKeys(item.hit);
      if (dedupeKeys.some((key) => seen.has(key))) {
        continue;
      }

      dedupeKeys.forEach((key) => seen.add(key));
      connectorCounts.set(item.hit.connector, usedCount + 1);
      selected.push(item);
      if (selected.length >= 8) {
        break;
      }
    }

    const selectedIds = new Set(selected.map((item) => item.hit.id));

    return {
      items: selected,
      debug: candidates
        .sort((left, right) => right.score - left.score || left.hit.id.localeCompare(right.hit.id))
        .map((item) => ({
          id: item.hit.id,
          score: item.score,
          scoreBreakdown: item.scoreBreakdown,
          matchedKeywords: item.matchedKeywords,
          matchedReason: item.matchedReason,
          filteredOutReason:
            item.filteredOutReason ??
            (selectedIds.has(item.hit.id) ? null : `below ranking cutoff (${minimumScore.toFixed(2)})`),
        })),
    };
  }

  private dedupeKeys(hit: KnowledgeDiscoveryHit | DatasetDiscoveryHit): string[] {
    const canonicalTitle = tokenize(hit.title).join(' ');
    const sourceIdentity =
      hit.kind === 'dataset'
        ? `${hit.entry.provider.toLowerCase()}:${canonicalTitle}`
        : `${hit.entry.source.toLowerCase()}:${canonicalTitle}`;
    const urlIdentity = hit.kind === 'dataset' ? hit.entry.sourceUrl : hit.entry.sourceUrl;
    return uniqueKeepOrder([
      canonicalTitle ? `${hit.kind}:title:${canonicalTitle}` : '',
      sourceIdentity,
      urlIdentity ? `${hit.kind}:url:${urlIdentity}` : '',
    ].filter(Boolean));
  }
}
