import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../../common/contracts';
import { tokenize, uniqueKeepOrder } from '../../common/text';
import type { DiscoveryPlan } from './types/collection-plan';
import type {
  DatasetDiscoveryHit,
  DiscoveryRankingDebug,
  DiscoveryRankingOutcome,
  KnowledgeDiscoveryHit,
  RankedCandidate,
} from './types/collection-hit';

type OrderableHit = DatasetDiscoveryHit | KnowledgeDiscoveryHit;
type SourceProfile = 'medical-trust' | 'generic' | 'non-medical';

type RankingConfig = {
  medicalGateEnabled: boolean;
  medicalMinSignalMatch: number;
  medicalMinDomainScore: number;
  nonMedicalPenaltyEnabled: boolean;
  nonMedicalPenaltyWeight: number;
  nonMedicalStrictExclude: boolean;
  nonMedicalStrictTerms: string[];
  weightMedicalSignal: number;
  weightDomainMatch: number;
  weightKeywordMatch: number;
  weightTaskModalityMatch: number;
  weightMetadataCompleteness: number;
  weightBrowserPenalty: number;
  weightSourceMedicalTrust: number;
  weightSourceGeneric: number;
  weightSourceNonMedical: number;
};

@Injectable()
export class CollectionOrderingService {
  private readonly config: RankingConfig = {
    medicalGateEnabled: this.readBool('MEDICAL_GATE_ENABLED', true),
    medicalMinSignalMatch: this.readNumber('MEDICAL_MIN_SIGNAL_MATCH', 2),
    medicalMinDomainScore: this.readNumber('MEDICAL_MIN_DOMAIN_SCORE', 0.35),
    nonMedicalPenaltyEnabled: this.readBool('NON_MEDICAL_PENALTY_ENABLED', true),
    nonMedicalPenaltyWeight: this.readNumber('NON_MEDICAL_PENALTY_WEIGHT', -8),
    nonMedicalStrictExclude: this.readBool('NON_MEDICAL_STRICT_EXCLUDE', true),
    nonMedicalStrictTerms: this.readStringList(
      'NON_MEDICAL_STRICT_TERMS',
      'stock,ohlcv,fraud,authorship,essay,stylometry,predictive maintenance',
    ),
    weightMedicalSignal: this.readNumber('WEIGHT_MEDICAL_SIGNAL', 4),
    weightDomainMatch: this.readNumber('WEIGHT_DOMAIN_MATCH', 5),
    weightKeywordMatch: this.readNumber('WEIGHT_KEYWORD_MATCH', 1),
    weightTaskModalityMatch: this.readNumber('WEIGHT_TASK_MODALITY_MATCH', 2),
    weightMetadataCompleteness: this.readNumber('WEIGHT_METADATA_COMPLETENESS', 1),
    weightBrowserPenalty: this.readNumber('WEIGHT_BROWSER_PENALTY', -2),
    weightSourceMedicalTrust: this.readNumber('WEIGHT_SOURCE_MEDICAL_TRUST', 3),
    weightSourceGeneric: this.readNumber('WEIGHT_SOURCE_GENERIC', 0.5),
    weightSourceNonMedical: this.readNumber('WEIGHT_SOURCE_NON_MEDICAL', -3),
  };

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
    const gateDebug: DiscoveryRankingDebug[] = [];
    const gatedHits = hits.filter((hit) => {
      const gate = this.evaluateMedicalGate(hit, context);
      if (!gate.passed) {
        gateDebug.push({
          id: hit.id,
          score: Number.NEGATIVE_INFINITY,
          scoreBreakdown: {},
          matchedKeywords: [],
          matchedReason: `medical-gate:signals=${gate.signalCount},domain=${gate.domainScore.toFixed(3)}`,
          filteredOutReason: 'excludedByMedicalGate',
        });
      }
      return gate.passed;
    });

    const ranked = gatedHits.map((hit) => this.rankHit(hit, plan, context));
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
      debug: [...gateDebug, ...debug],
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
    add('metadataCompleteness', metadataCompletenessScore * this.config.weightMetadataCompleteness);

    const taskMatchScore =
      (this.matchCount(hit.taskSignals, context.taskSignals) +
        this.matchCount(hit.modalitySignals, context.modalitySignals)) *
      this.config.weightTaskModalityMatch;
    add('taskMatch', taskMatchScore);

    const keywordMatchScore =
      uniqueKeepOrder([...hit.matchedTerms, ...this.queryTokenMatches(hit, plan)]).length *
      this.config.weightKeywordMatch;
    add('keywordMatch', keywordMatchScore);

    const mustAvoidPenalty = this.mustAvoidMatches(hit, plan.mustAvoid) * -4;
    add('mustAvoidPenalty', mustAvoidPenalty);

    const llmRelevanceScore = (hit.llmRelevance ?? 0) * 2;
    add('llmRelevance', llmRelevanceScore);

    const medicalSignals = this.medicalSignalsForHit(hit);
    const domainScoreRaw = this.domainScoreForHit(hit, medicalSignals);
    const medicalSignalsScore = medicalSignals.length * this.config.weightMedicalSignal;
    add('medicalSignalsMatched', medicalSignalsScore);

    const domainMatchScore = domainScoreRaw * this.config.weightDomainMatch;
    add('domainMatch', domainMatchScore);

    const sourceProfileScore = this.sourceProfileScore(hit);
    add('sourceProfile', sourceProfileScore);

    const nonMedicalPenalty = this.nonMedicalPenalty(hit);
    add('nonMedicalPenalty', nonMedicalPenalty);

    const browserPenalty =
      hit.extractionMethod === 'browser' ? this.config.weightBrowserPenalty : 0;
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

  private evaluateMedicalGate(hit: OrderableHit, context: DiscoveryContext): { passed: boolean; signalCount: number; domainScore: number } {
    if (!this.config.medicalGateEnabled || !this.isMedicalContext(context)) {
      const signals = this.medicalSignalsForHit(hit);
      return { passed: true, signalCount: signals.length, domainScore: this.domainScoreForHit(hit, signals) };
    }
    const signals = this.medicalSignalsForHit(hit);
    const signalCount = signals.length;
    const domainScore = this.domainScoreForHit(hit, signals);
    const passed =
      signalCount >= this.config.medicalMinSignalMatch &&
      domainScore >= this.config.medicalMinDomainScore;
    return { passed, signalCount, domainScore };
  }

  private nonMedicalPenalty(hit: OrderableHit): number {
    if (!this.config.nonMedicalPenaltyEnabled) {
      return 0;
    }
    const text = `${hit.title} ${hit.text} ${hit.entry.sourceUrl ?? ''}`.toLowerCase();
    const hasStrictTerm = this.config.nonMedicalStrictTerms.some((term) => text.includes(term.toLowerCase()));
    if (hasStrictTerm && this.config.nonMedicalStrictExclude) {
      return this.config.nonMedicalPenaltyWeight * 4;
    }
    return hasStrictTerm ? this.config.nonMedicalPenaltyWeight : 0;
  }

  private sourceProfileScore(hit: OrderableHit): number {
    const profile = this.classifySourceProfile(hit);
    if (profile === 'medical-trust') {
      return this.config.weightSourceMedicalTrust;
    }
    if (profile === 'non-medical') {
      return this.config.weightSourceNonMedical;
    }
    return this.config.weightSourceGeneric;
  }

  private classifySourceProfile(hit: OrderableHit): SourceProfile {
    const text = `${hit.title} ${hit.text} ${hit.entry.sourceUrl ?? ''}`.toLowerCase();
    const hasMedical =
      this.medicalSignalsForHit(hit).length > 0 ||
      /(clinical|patient|cohort|visit|outcome|mortality|ehr|emr|icu|sepsis|readmission)/.test(text);
    if (hasMedical) {
      return 'medical-trust';
    }
    if (/(stock|ohlcv|authorship|stylometry|fraud|predictive maintenance)/.test(text)) {
      return 'non-medical';
    }
    return 'generic';
  }

  private isMedicalContext(context: DiscoveryContext): boolean {
    const space = `${context.dataset.description} ${context.expandedKeywords.join(' ')} ${context.taskSignals.join(' ')} ${context.modalitySignals.join(' ')}`.toLowerCase();
    return /(clinical|patient|cohort|visit|outcome|mortality|ehr|emr|icu|sepsis|readmission|medical|hospital)/.test(space);
  }

  private medicalSignalsForHit(hit: OrderableHit): string[] {
    if (Array.isArray(hit.medicalSignalsMatched) && hit.medicalSignalsMatched.length > 0) {
      return hit.medicalSignalsMatched;
    }
    const text = `${hit.title} ${hit.text} ${hit.entry.sourceUrl ?? ''}`.toLowerCase();
    const dictionary = [
      'clinical',
      'patient',
      'cohort',
      'visit',
      'outcome',
      'mortality',
      'ehr',
      'emr',
      'icu',
      'sepsis',
      'readmission',
    ];
    return dictionary.filter((token) => text.includes(token));
  }

  private domainScoreForHit(hit: OrderableHit, medicalSignals: string[]): number {
    if (typeof hit.domainMatchScore === 'number' && Number.isFinite(hit.domainMatchScore)) {
      return hit.domainMatchScore;
    }
    return Math.min(1, medicalSignals.length / 6);
  }

  private readBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw == null) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  }

  private readNumber(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readStringList(key: string, fallbackCsv: string): string[] {
    const raw = process.env[key] ?? fallbackCsv;
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
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
