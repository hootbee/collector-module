import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../../common/contracts';
import { tokenize, uniqueKeepOrder } from '../../common/text';
import type { DiscoveryPlan } from './types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoveryRankingOutcome,
  KnowledgeDiscoveryHit,
  RankedCandidate,
} from './types/collection-hit';

type OrderableHit = DatasetDiscoveryHit | KnowledgeDiscoveryHit;

@Injectable()
export class CollectionOrderingService {
  orderKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): DiscoveryRankingOutcome<KnowledgeDiscoveryHit> {
    return this.orderHits(hits, plan, context);
  }

  orderDatasetHits(
    hits: DatasetDiscoveryHit[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): DiscoveryRankingOutcome<DatasetDiscoveryHit> {
    return this.orderHits(hits, plan, context);
  }

  private orderHits<T extends OrderableHit>(
    hits: T[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): DiscoveryRankingOutcome<T> {
    const ranked = hits.map((hit) => this.rankHit(hit, plan, context));
    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return this.canonicalTitle(left.hit.title).localeCompare(this.canonicalTitle(right.hit.title));
    });

    const deduped: RankedCandidate<T>[] = [];
    const debug = [];
    const seen = new Set<string>();

    for (const item of ranked) {
      const duplicateKey = this.duplicateKey(item.hit);
      if (seen.has(duplicateKey)) {
        debug.push({
          id: item.hit.id,
          score: item.score,
          scoreBreakdown: item.scoreBreakdown,
          matchedKeywords: item.matchedKeywords,
          matchedReason: item.matchedReason,
          filteredOutReason: 'duplicate',
        });
        continue;
      }
      seen.add(duplicateKey);
      deduped.push(item);
      debug.push({
        id: item.hit.id,
        score: item.score,
        scoreBreakdown: item.scoreBreakdown,
        matchedKeywords: item.matchedKeywords,
        matchedReason: item.matchedReason,
        filteredOutReason: null,
      });
    }

    return {
      items: deduped,
      debug,
    };
  }

  private rankHit<T extends OrderableHit>(
    hit: T,
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): RankedCandidate<T> {
    const scoreBreakdown: Record<string, number> = {};
    const add = (key: string, value: number) => {
      scoreBreakdown[key] = value;
    };

    const structuredBonus = hit.layer === 'structured' ? 16 : 0;
    add('structuredBonus', structuredBonus);

    const knownSourceBonus = hit.sourceClassification === 'known' ? 8 : 0;
    add('knownSourceBonus', knownSourceBonus);

    const unknownSourcePenalty = hit.sourceClassification === 'unknown' ? -3 : 0;
    add('unknownSourcePenalty', unknownSourcePenalty);

    const directDownloadBonus = hit.directDownloadAvailable ? 4 : 0;
    add('directDownloadBonus', directDownloadBonus);

    const sourcePriorityScore = hit.sourcePriority * 8;
    add('sourcePriority', sourcePriorityScore);

    const sourceReliabilityScore = hit.sourceReliability * 8;
    add('sourceReliability', sourceReliabilityScore);

    const metadataCompletenessScore = (hit.metadataCompleteness ?? 0) * 8;
    add('metadataCompleteness', metadataCompletenessScore);

    const taskMatchScore = this.matchCount(hit.taskSignals, context.taskSignals) * 2;
    add('taskMatch', taskMatchScore);

    const modalityMatchScore = this.matchCount(hit.modalitySignals, context.modalitySignals) * 1.5;
    add('modalityMatch', modalityMatchScore);

    const keywordMatchScore = uniqueKeepOrder([...hit.matchedTerms, ...this.queryTokenMatches(hit, plan)]).length * 1.2;
    add('keywordMatch', keywordMatchScore);

    const mustAvoidPenalty = this.mustAvoidMatches(hit, plan.mustAvoid) * -4;
    add('mustAvoidPenalty', mustAvoidPenalty);

    const llmRelevanceScore = (hit.llmRelevance ?? 0) * 2;
    add('llmRelevance', llmRelevanceScore);

    const browserPenalty = hit.extractionMethod === 'browser' ? -2 : 0;
    add('browserPenalty', browserPenalty);

    const htmlPenalty = hit.extractionMethod === 'html' ? -0.5 : 0;
    add('htmlPenalty', htmlPenalty);

    const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
    const matchedKeywords = uniqueKeepOrder([
      ...hit.matchedTerms,
      ...this.queryTokenMatches(hit, plan),
    ]).slice(0, 10);

    const matchedReasonParts = [
      hit.layer ? `layer=${hit.layer}` : '',
      hit.sourceClassification ? `classification=${hit.sourceClassification}` : '',
      hit.directDownloadAvailable ? 'downloadable' : '',
      hit.routedConnector && hit.routedConnector !== hit.connector ? `rerouted=${hit.routedConnector}` : '',
    ].filter(Boolean);

    return {
      hit,
      score,
      scoreBreakdown,
      matchedKeywords,
      matchedReason: matchedReasonParts.length > 0 ? matchedReasonParts.join(' | ') : `connector=${hit.connector}`,
      filteredOutReason: null,
    };
  }

  private queryTokenMatches(hit: OrderableHit, plan: DiscoveryPlan): string[] {
    const textTokens = new Set(
      tokenize(hit.title, hit.text, hit.entry.sourceUrl ?? '', ...(hit.matchedQueries ?? [])),
    );
    return uniqueKeepOrder(
      [...plan.mustInclude, ...plan.datasetQueries, ...plan.knowledgeQueries]
        .flatMap((value) => tokenize(value))
        .filter((token) => textTokens.has(token)),
    ).slice(0, 8);
  }

  private mustAvoidMatches(hit: OrderableHit, mustAvoid: string[]): number {
    if (mustAvoid.length === 0) {
      return 0;
    }
    const tokens = new Set(tokenize(hit.title, hit.text, hit.entry.sourceUrl ?? ''));
    return mustAvoid.flatMap((item) => tokenize(item)).filter((token) => tokens.has(token)).length;
  }

  private matchCount(left: string[], right: string[]): number {
    const rightSet = new Set(right);
    return left.filter((item) => rightSet.has(item)).length;
  }

  private duplicateKey(hit: OrderableHit): string {
    const exactUrl = hit.entry.sourceUrl?.trim().toLowerCase();
    if (exactUrl) {
      return `${hit.kind}:url:${exactUrl}`;
    }
    const downloadUrl = 'downloadUrl' in hit.entry ? hit.entry.downloadUrl?.trim().toLowerCase() : undefined;
    if (downloadUrl) {
      return `${hit.kind}:download:${downloadUrl}`;
    }
    const provider = 'provider' in hit.entry ? hit.entry.provider : hit.entry.source;
    return `${hit.kind}:title:${provider.toLowerCase()}:${this.canonicalTitle(hit.title)}`;
  }

  private canonicalTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
}
