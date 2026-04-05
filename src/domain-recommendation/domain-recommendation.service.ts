import { Injectable } from '@nestjs/common';
import { domainCatalog, modalityCatalog, taskCatalog } from '../common/catalog';
import type {
  DatasetAnalysisResponse,
  DatasetRecord,
  DiscoveryContext,
  DomainCatalogEntry,
  DomainDatasetSummary,
  DomainRecommendationResponse,
  ModalitySignal,
  RecommendedDomain,
  TaskSignal,
} from '../common/contracts';
import { stableHash, tokenize, uniqueKeepOrder } from '../common/text';
import { OpenAiRecommendationService } from '../llm/openai-recommendation.service';
import { ProfilingService } from '../profiling/profiling.service';

type DatasetSignalProfile = {
  metadataColumns: string[];
  featureColumns: string[];
  textColumns: string[];
  idColumns: string[];
  temporalColumns: string[];
  supportColumns: string[];
  targetValueLabels: string[];
  taskSignals: TaskSignal[];
  modalitySignals: ModalitySignal[];
  intentSignals: string[];
  modality: 'text' | 'table' | 'hybrid';
  descriptionSignals: string[];
  extractedKeywords: string[];
  expandedKeywordSeeds: string[];
  targetTokens: Set<string>;
  labelTokens: Set<string>;
  textFeatureTokens: Set<string>;
  supportTokens: Set<string>;
  descriptionTokens: Set<string>;
  allTokens: Set<string>;
};

type DomainScoreBreakdown = {
  domainId: string;
  score: number;
  strongMatches: string[];
  supportMatches: string[];
  negativeMatches: string[];
  reasons: string[];
};

type RankedDomain = {
  score: number;
  jitter: number;
  breakdown: DomainScoreBreakdown;
  domainResult: RecommendedDomain;
};

type RankedSignal<T extends string> = {
  id: T;
  score: number;
  reasons: string[];
};

@Injectable()
export class DomainRecommendationService {
  constructor(
    private readonly profilingService: ProfilingService,
    private readonly openAiRecommendationService: OpenAiRecommendationService,
  ) {}

  buildDatasetSummary(
    dataset: DatasetRecord,
    metadataColumns: string[],
    analysis?: DatasetAnalysisResponse,
  ): DomainDatasetSummary {
    const resolvedAnalysis = analysis ?? dataset.analysis ?? this.profilingService.analyzeDataset(dataset);
    const features = this.featureColumns(dataset, metadataColumns, resolvedAnalysis);
    return {
      fileName: dataset.fileName,
      rowCount: dataset.rowCount,
      colCount: dataset.colCount,
      taskType: dataset.taskType,
      metaColumns: [...metadataColumns],
      featureColumnCount: features.length,
      featureColumns: [...features],
      taskSignals: [...(resolvedAnalysis.taskSignals ?? [])],
      modalitySignals: [...(resolvedAnalysis.modalitySignals ?? [])],
      targetColumns: [...dataset.targetColumns],
      description: dataset.description,
    };
  }

  async recommendDataset(input: {
    dataset: DatasetRecord;
    metadataColumns?: string[];
    refreshSeed?: number;
  }): Promise<DomainRecommendationResponse> {
    const analysis = input.dataset.analysis ?? this.profilingService.analyzeDataset(input.dataset);
    const metadataColumns =
      input.metadataColumns && input.metadataColumns.length > 0
        ? input.metadataColumns
        : analysis.metadataCandidates;

    const ruleBasedRecommendation = this.recommendDatasetRuleBased({
      dataset: input.dataset,
      metadataColumns,
      refreshSeed: input.refreshSeed,
      analysis,
    });

    const openAiRecommendation = await this.openAiRecommendationService.generateRecommendation({
      dataset: input.dataset,
      analysis,
      metadataColumns,
      datasetSummary: ruleBasedRecommendation.datasetSummary,
      deterministicFeatureColumns: analysis.featureColumns,
    });

    return openAiRecommendation ?? ruleBasedRecommendation;
  }

  recommendDatasetRuleBased(input: {
    dataset: DatasetRecord;
    metadataColumns?: string[];
    refreshSeed?: number;
    analysis?: DatasetAnalysisResponse;
  }): DomainRecommendationResponse {
    const analysis = input.analysis ?? input.dataset.analysis ?? this.profilingService.analyzeDataset(input.dataset);
    const metadataColumns =
      input.metadataColumns && input.metadataColumns.length > 0
        ? input.metadataColumns
        : analysis.metadataCandidates;
    const refreshSeed = input.refreshSeed ?? 0;
    const profile = this.buildDatasetSignalProfile(input.dataset, analysis, metadataColumns);
    const taskRanking = this.rankTaskSignals(profile);
    const modalityRanking = this.rankModalitySignals(profile);

    console.info(
      `[DomainRecommendationService] dataset signals ${JSON.stringify({
        datasetId: input.dataset.id,
        modality: profile.modality,
        taskSignals: profile.taskSignals,
        modalitySignals: profile.modalitySignals,
        intentSignals: profile.intentSignals,
        targetValueLabels: profile.targetValueLabels,
        chosenFeatureColumns: profile.featureColumns,
        chosenMetadataColumns: profile.metadataColumns,
        inferredTextColumns: profile.textColumns,
        inferredIdColumns: profile.idColumns,
        inferredTemporalColumns: profile.temporalColumns,
        extractedKeywords: profile.extractedKeywords,
      })}`,
    );
    console.info(
      `[DomainRecommendationService] task/modality scores ${JSON.stringify({
        datasetId: input.dataset.id,
        tasks: taskRanking,
        modalities: modalityRanking,
      })}`,
    );

    const rankedCandidates = domainCatalog
      .map((domain) => this.scoreDomain(domain, profile, refreshSeed))
      .filter((item) => item.score > 0.1);

    const fallbackCandidates =
      rankedCandidates.length > 0
        ? rankedCandidates
        : domainCatalog.map((domain) => ({
            score: 0.1,
            jitter: stableHash(`${domain.id}:${refreshSeed}`) / 1_000_000_000,
            breakdown: {
              domainId: domain.id,
              score: 0.1,
              strongMatches: [],
              supportMatches: [],
              negativeMatches: [],
              reasons: ['general fallback candidate'],
            },
            domainResult: {
              id: domain.id,
              name: domain.title,
              shortDescription: domain.shortDescription,
              recommendationReason: 'general fallback candidate',
              keywords: domain.keywords.slice(0, 5),
              relevance: 'low' as const,
            },
          }));

    const sortedCandidates = fallbackCandidates
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.jitter - right.jitter;
      });
    const leaderScore = sortedCandidates[0]?.score ?? 0;
    const recommendationCutoff =
      leaderScore <= 0.11
        ? 0
        : profile.modality === 'text'
          ? Math.max(4.5, leaderScore * 0.35)
          : Math.max(2.5, leaderScore * 0.25);
    const ranked = sortedCandidates
      .filter((item, index) => index === 0 || item.score >= recommendationCutoff)
      .slice(0, 5);

    console.info(
      `[DomainRecommendationService] top domain scores ${JSON.stringify(
        ranked.slice(0, 8).map((item) => ({
          ...item.breakdown,
          cutoff: recommendationCutoff,
        })),
      )}`,
    );

    const recommendedDomains = ranked.map((item) => item.domainResult);
    const primaryDomainId = recommendedDomains[0]?.id ?? null;
    const evidenceSummary = {
      extractedKeywords: profile.extractedKeywords.slice(0, 12),
      influentialFeatureColumns: profile.featureColumns.slice(0, 6),
      influentialTargetColumns: [...input.dataset.targetColumns].slice(0, 4),
      descriptionSignals: profile.descriptionSignals.slice(0, 6),
    };

    const expandedKeywords = this.buildExpandedKeywords(profile, recommendedDomains);
    const generatedQueries = this.buildGeneratedQueries(profile, recommendedDomains);

    return {
      sessionId: input.dataset.sessionId,
      datasetId: input.dataset.id,
      datasetSummary: this.buildDatasetSummary(input.dataset, metadataColumns, analysis),
      evidenceSummary,
      primaryDomainId,
      taskSignals: [...profile.taskSignals],
      modalitySignals: [...profile.modalitySignals],
      recommendedDomains,
      expandedKeywords,
      generatedQueries,
    };
  }

  buildDiscoveryContext(input: {
    dataset: DatasetRecord;
    metadataColumns: string[];
    selectedDomains: string[];
  }): DiscoveryContext {
    const analysis = input.dataset.analysis ?? this.profilingService.analyzeDataset(input.dataset);
    const recommendation =
      input.dataset.recommendation ??
      this.recommendDatasetRuleBased({
        dataset: input.dataset,
        metadataColumns: input.metadataColumns,
        analysis,
      });
    const profile = this.buildDatasetSignalProfile(input.dataset, analysis, input.metadataColumns);
    const selectedDomainIds = this.resolveSelectedDomainIds(input.selectedDomains, recommendation);

    return {
      dataset: input.dataset,
      selectedDomains: [...input.selectedDomains],
      selectedDomainIds,
      primaryDomainId: recommendation.primaryDomainId ?? recommendation.recommendedDomains[0]?.id ?? null,
      taskSignals: [...(recommendation.taskSignals ?? profile.taskSignals)],
      modalitySignals: [...(recommendation.modalitySignals ?? profile.modalitySignals)],
      metadataColumns: [...input.metadataColumns],
      featureColumns: [...profile.featureColumns],
      textColumns: [...profile.textColumns],
      idColumns: [...profile.idColumns],
      temporalColumns: [...profile.temporalColumns],
      supportColumns: [...profile.supportColumns],
      labelHints: [...profile.targetValueLabels],
      modality: profile.modality,
      descriptionSignals: [...profile.descriptionSignals],
      expandedKeywords: [...recommendation.expandedKeywords],
      generatedQueries: [...recommendation.generatedQueries],
    };
  }

  private buildDatasetSignalProfile(
    dataset: DatasetRecord,
    analysis: DatasetAnalysisResponse,
    metadataColumns: string[],
  ): DatasetSignalProfile {
    const featureColumns = this.featureColumns(dataset, metadataColumns, analysis);
    const textColumns = featureColumns.filter((column) => analysis.inferredTextColumns.includes(column));
    const supportColumns = featureColumns.filter((column) => !textColumns.includes(column));
    const targetValueLabels = uniqueKeepOrder(
      analysis.imbalanceSummary.flatMap((item) => item.stat?.valueCounts.map((value) => value.value) ?? []),
    ).slice(0, 4);
    const taskSignals = [...(analysis.taskSignals ?? [])];
    const modalitySignals = [...(analysis.modalitySignals ?? [])];

    const descriptionTokens = new Set(tokenize(dataset.description, dataset.fileName));
    const targetTokens = new Set(tokenize(dataset.targetColumns.join(' ')));
    const labelTokens = new Set(tokenize(targetValueLabels.join(' ')));
    const textFeatureTokens = new Set(tokenize(textColumns.join(' ')));
    const supportTokens = new Set(tokenize(supportColumns.join(' ')));
    const allTokens = new Set(
      tokenize(
        dataset.columns.join(' '),
        dataset.description,
        featureColumns.join(' '),
        textColumns.join(' '),
        supportColumns.join(' '),
        targetValueLabels.join(' '),
      ),
    );

    const aiHumanSignals = this.detectAiHumanSignals(dataset, textColumns, supportColumns, targetValueLabels);
    const financialForecastSignals = this.detectFinancialForecastSignals(
      dataset,
      supportColumns,
      analysis.inferredTemporalColumns,
      taskSignals,
    );
    const intentSignals = uniqueKeepOrder([...aiHumanSignals, ...financialForecastSignals]);
    const modality: 'text' | 'table' | 'hybrid' =
      textColumns.length >= 2 || aiHumanSignals.length > 0
        ? 'text'
        : textColumns.length === 1
          ? 'hybrid'
          : 'table';

    const descriptionSignals = this.descriptionSignals(dataset, analysis, {
      featureColumns,
      textColumns,
      supportColumns,
      targetValueLabels,
      modality,
      intentSignals,
      taskSignals,
      modalitySignals,
    });

    const expandedKeywordSeeds = uniqueKeepOrder([
      ...intentSignals,
      ...textColumns,
      ...supportColumns.slice(0, 6),
      ...dataset.targetColumns,
      ...targetValueLabels,
      ...taskSignals,
      ...modalitySignals,
      modality === 'text' ? 'text classification' : '',
    ]).filter(Boolean);

    const extractedKeywords = uniqueKeepOrder([
      ...expandedKeywordSeeds,
      ...featureColumns.slice(0, 6),
      ...dataset.targetColumns,
    ]).slice(0, 12);

    return {
      metadataColumns,
      featureColumns,
      textColumns,
      idColumns: [...analysis.inferredIdColumns],
      temporalColumns: [...analysis.inferredTemporalColumns],
      supportColumns,
      targetValueLabels,
      taskSignals,
      modalitySignals,
      intentSignals,
      modality,
      descriptionSignals,
      extractedKeywords,
      expandedKeywordSeeds,
      targetTokens,
      labelTokens,
      textFeatureTokens,
      supportTokens,
      descriptionTokens,
      allTokens,
    };
  }

  private scoreDomain(
    domain: DomainCatalogEntry,
    profile: DatasetSignalProfile,
    refreshSeed: number,
  ): RankedDomain {
    const strongTokens = new Set(tokenize((domain.strongSignals ?? []).join(' '), ...(domain.aliases ?? [])));
    const supportTokens = new Set(
      tokenize(
        domain.keywords.join(' '),
        (domain.supportSignals ?? []).join(' '),
        domain.title,
        domain.shortDescription,
      ),
    );
    const negativeTokens = new Set(tokenize((domain.negativeSignals ?? []).join(' ')));

    const strongMatches = uniqueKeepOrder([
      ...this.collectMatches(profile.targetTokens, strongTokens),
      ...this.collectMatches(profile.labelTokens, strongTokens),
      ...this.collectMatches(profile.textFeatureTokens, strongTokens),
      ...this.collectMatches(profile.supportTokens, strongTokens),
      ...this.collectMatches(profile.descriptionTokens, strongTokens),
    ]);
    const supportMatches = uniqueKeepOrder([
      ...this.collectMatches(profile.targetTokens, supportTokens),
      ...this.collectMatches(profile.labelTokens, supportTokens),
      ...this.collectMatches(profile.textFeatureTokens, supportTokens),
      ...this.collectMatches(profile.supportTokens, supportTokens),
      ...this.collectMatches(profile.descriptionTokens, supportTokens),
    ]);
    const negativeMatches = uniqueKeepOrder(this.collectMatches(profile.allTokens, negativeTokens));

    let score = 0;
    score += this.collectMatches(profile.targetTokens, strongTokens).length * 4.5;
    score += this.collectMatches(profile.labelTokens, strongTokens).length * 4.5;
    score += this.collectMatches(profile.textFeatureTokens, strongTokens).length * 4;
    score += this.collectMatches(profile.descriptionTokens, strongTokens).length * 3.5;
    score += this.collectMatches(profile.supportTokens, strongTokens).length * 2.5;
    score += supportMatches.length * 1.6;

    if (profile.taskSignals.includes('time-series-forecasting') && domain.id === 'dom-finance') {
      score += 4.2;
    }
    if (profile.taskSignals.includes('content-authenticity')) {
      if (domain.id === 'dom-ai-generated-content-detection') {
        score += 4.6;
      } else if (domain.id === 'dom-content-authenticity') {
        score += 4.2;
      } else if (domain.id === 'dom-nlp' || domain.id === 'dom-text-classification') {
        score += 2.4;
      }
    }
    if (profile.taskSignals.includes('authorship-attribution') && domain.id === 'dom-authorship-attribution') {
      score += 4.4;
    }
    if (profile.modalitySignals.includes('transaction') && domain.id === 'dom-finance') {
      score += 1.8;
    }
    if (profile.modalitySignals.includes('longitudinal') && domain.id === 'dom-medical') {
      score += 1.8;
    }
    if (profile.modalitySignals.includes('time-series') && domain.id === 'dom-finance') {
      score += 1.8;
    }

    if (profile.modality === domain.modality) {
      score += 2.4;
    } else if (profile.modality === 'text' && domain.modality === 'table' && strongMatches.length === 0) {
      score -= 6;
    } else if (profile.modality === 'table' && domain.modality === 'text' && strongMatches.length === 0) {
      score -= 4;
    } else if (profile.modality === 'hybrid' && domain.modality === 'text') {
      score += 1.2;
    }

    if (profile.modality === 'text' && strongMatches.length === 0 && domain.modality === 'table') {
      score -= 3;
    }

    score -= negativeMatches.length * 2.8;

    const jitter = stableHash(`${domain.id}:${refreshSeed}`) / 1_000_000_000;
    const relevance =
      score >= 8 ? 'high' : score >= 4.5 ? 'medium' : 'low';
    const evidence = this.buildRecommendationEvidence(domain, profile, strongMatches, supportMatches);

    return {
      score,
      jitter,
      breakdown: {
        domainId: domain.id,
        score,
        strongMatches,
        supportMatches,
        negativeMatches,
        reasons: evidence,
      },
      domainResult: {
        id: domain.id,
        name: domain.title,
        shortDescription: domain.shortDescription,
        recommendationReason: `${domain.reasonTemplate ?? 'The dataset signals match this domain.'} Evidence: ${evidence.join('; ')}.`,
        keywords:
          uniqueKeepOrder([
            ...strongMatches,
            ...supportMatches,
            ...domain.keywords,
          ]).slice(0, 6),
        relevance,
      },
    };
  }

  private rankTaskSignals(profile: DatasetSignalProfile): RankedSignal<TaskSignal>[] {
    return taskCatalog
      .map((task) => {
        const strongTokens = new Set(tokenize(task.id, (task.aliases ?? []).join(' '), (task.strongSignals ?? []).join(' ')));
        const supportTokens = new Set(tokenize((task.supportSignals ?? []).join(' '), ...(task.querySeeds ?? [])));
        const directMatch = profile.taskSignals.includes(task.id) ? 8 : 0;
        const strongMatchCount = this.collectMatches(profile.allTokens, strongTokens).length;
        const supportMatchCount = this.collectMatches(profile.allTokens, supportTokens).length;
        const reasons = uniqueKeepOrder([
          directMatch > 0 ? 'analysis-inferred signal' : '',
          strongMatchCount > 0 ? `strong token overlap=${strongMatchCount}` : '',
          supportMatchCount > 0 ? `support token overlap=${supportMatchCount}` : '',
        ]).filter(Boolean);

        return {
          id: task.id,
          score: directMatch + strongMatchCount * 2.8 + supportMatchCount * 1.2,
          reasons,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }

  private rankModalitySignals(profile: DatasetSignalProfile): RankedSignal<ModalitySignal>[] {
    return modalityCatalog
      .map((modality) => {
        const tokens = new Set(tokenize(modality.id, (modality.aliases ?? []).join(' '), (modality.keywords ?? []).join(' ')));
        const directMatch = profile.modalitySignals.includes(modality.id) ? 8 : 0;
        const overlap = this.collectMatches(profile.allTokens, tokens).length;
        const reasons = uniqueKeepOrder([
          directMatch > 0 ? 'analysis-inferred signal' : '',
          overlap > 0 ? `token overlap=${overlap}` : '',
        ]).filter(Boolean);

        return {
          id: modality.id,
          score: directMatch + overlap * 1.6,
          reasons,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }

  private buildRecommendationEvidence(
    domain: DomainCatalogEntry,
    profile: DatasetSignalProfile,
    strongMatches: string[],
    supportMatches: string[],
  ): string[] {
    const reasons: string[] = [];
    if (profile.textColumns.length > 0 && domain.modality === 'text') {
      reasons.push(`text columns ${profile.textColumns.slice(0, 3).join(', ')} are present`);
    }
    if (profile.targetValueLabels.length > 0) {
      reasons.push(`target labels include ${profile.targetValueLabels.slice(0, 3).join(', ')}`);
    }
    if (profile.taskSignals.length > 0) {
      reasons.push(`task signals ${profile.taskSignals.slice(0, 3).join(', ')}`);
    }
    if (profile.modalitySignals.length > 0) {
      reasons.push(`modality signals ${profile.modalitySignals.slice(0, 3).join(', ')}`);
    }
    if (profile.supportColumns.length > 0 && (domain.modality === 'text' || supportMatches.length > 0)) {
      reasons.push(`support features include ${profile.supportColumns.slice(0, 4).join(', ')}`);
    }
    if (strongMatches.length > 0) {
      reasons.push(`strong signal overlap on ${strongMatches.slice(0, 5).join(', ')}`);
    }
    if (supportMatches.length > 0) {
      reasons.push(`secondary overlap on ${supportMatches.slice(0, 4).join(', ')}`);
    }
    if (profile.descriptionSignals.length > 0) {
      reasons.push(profile.descriptionSignals[0]);
    }

    return uniqueKeepOrder(reasons).slice(0, 4);
  }

  private buildExpandedKeywords(
    profile: DatasetSignalProfile,
    recommendedDomains: RecommendedDomain[],
  ): string[] {
    const seedKeywords = uniqueKeepOrder([
      ...profile.expandedKeywordSeeds,
      ...profile.intentSignals,
      ...profile.textColumns,
      ...profile.supportColumns.slice(0, 4),
      ...profile.taskSignals,
      ...profile.modalitySignals,
      ...recommendedDomains.slice(0, 2).flatMap((domain) => domain.keywords),
    ]);

    const bannedForText = new Set(['biomarker', 'specimen', 'patient', 'visit', 'fraud', 'transaction', 'sensor']);
    const bannedForTimeSeriesFinance = new Set([
      'biomarker',
      'specimen',
      'patient',
      'visit',
      'essay',
      'authorship',
      'fraud',
      'transaction',
      'payment',
      'merchant',
      'card',
      'chargeback',
      'identity',
    ]);
    return seedKeywords
      .filter((keyword) => {
        if (profile.modality === 'text' && bannedForText.has(keyword.toLowerCase())) {
          return false;
        }
        if (
          profile.taskSignals.includes('time-series-forecasting') &&
          bannedForTimeSeriesFinance.has(keyword.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 18);
  }

  private buildGeneratedQueries(
    profile: DatasetSignalProfile,
    recommendedDomains: RecommendedDomain[],
  ): string[] {
    const domainSeedQueries = uniqueKeepOrder(
      recommendedDomains.flatMap((domain) => {
        const match = domainCatalog.find((entry) => entry.id === domain.id);
        return match?.querySeeds ?? [];
      }),
    );

    if (profile.modality === 'text') {
      const textQueries = uniqueKeepOrder([
        profile.targetValueLabels.includes('ai') && profile.targetValueLabels.includes('human')
          ? 'AI vs human generated text classification dataset'
          : '',
        profile.textColumns.length > 0
          ? 'authorship attribution dataset with prompts and content'
          : '',
        profile.supportColumns.some((column) => /source|topic|language/i.test(column))
          ? 'generated content detection benchmark with topic and language metadata'
          : '',
        'text authenticity classification dataset with metadata',
        'human vs machine written content detection dataset',
        ...domainSeedQueries,
      ]).filter(Boolean);

      return textQueries.slice(0, 5);
    }

    if (profile.taskSignals.includes('time-series-forecasting')) {
      const financeForecastQueries = uniqueKeepOrder([
        'historical stock price forecasting dataset',
        'OHLCV time series regression data',
        'financial market technical indicator dataset for price prediction',
        'stock return and volatility time series data',
        ...domainSeedQueries,
      ]).filter(Boolean);

      return financeForecastQueries.slice(0, 5);
    }

    return uniqueKeepOrder(
      recommendedDomains.slice(0, 3).flatMap((domain) => {
        const match = domainCatalog.find((entry) => entry.id === domain.id);
        return match?.querySeeds ?? [domain.name];
      }),
    ).slice(0, 5);
  }

  private featureColumns(
    dataset: DatasetRecord,
    metadataColumns: string[],
    analysis?: DatasetAnalysisResponse,
  ): string[] {
    if (analysis?.featureColumns?.length) {
      return [...analysis.featureColumns];
    }

    const metadataSet = new Set(metadataColumns);
    const targetSet = new Set(dataset.targetColumns);
    return dataset.columns.filter((column) => !metadataSet.has(column) && !targetSet.has(column));
  }

  private detectAiHumanSignals(
    dataset: DatasetRecord,
    textColumns: string[],
    supportColumns: string[],
    targetValueLabels: string[],
  ): string[] {
    const columnBlob = dataset.columns.join(' ').toLowerCase();
    const description = dataset.description.toLowerCase();
    const labelBlob = targetValueLabels.join(' ').toLowerCase();
    const signals: string[] = [];

    if (
      /ai|human|generated|machine|llm|gpt/.test(description) ||
      /ai|human|generated|machine|llm|gpt/.test(labelBlob) ||
      /ai_model/.test(columnBlob)
    ) {
      signals.push('ai generated text detection', 'human written content classification');
    }
    if (textColumns.length > 0) {
      signals.push('prompt based text classification');
    }
    if (supportColumns.some((column) => /source|topic|language/i.test(column))) {
      signals.push('source and topic metadata', 'language and style features');
    }

    return uniqueKeepOrder(signals);
  }

  private detectFinancialForecastSignals(
    dataset: DatasetRecord,
    supportColumns: string[],
    temporalColumns: string[],
    taskSignals: TaskSignal[],
  ): string[] {
    const combinedBlob = [dataset.columns.join(' '), dataset.description, supportColumns.join(' ')].join(' ').toLowerCase();
    const signals: string[] = [];
    const hasFinanceForecastBase =
      taskSignals.includes('time-series-forecasting') ||
      /stock|market|ohlcv|close|open|high|low|volume|return|volatility|rsi|macd|price/.test(combinedBlob);

    if (hasFinanceForecastBase) {
      signals.push(
        'stock price',
        'historical market data',
        'OHLCV',
        'technical analysis',
        'financial time series',
        'regression forecasting',
      );
    }

    if (/rsi|macd|volatility/.test(combinedBlob)) {
      signals.push('RSI', 'MACD', 'volatility');
    }

    if (hasFinanceForecastBase && temporalColumns.length > 0) {
      signals.push('time series');
    }

    return uniqueKeepOrder(signals);
  }

  private descriptionSignals(
    dataset: DatasetRecord,
    analysis: DatasetAnalysisResponse,
    input: {
      featureColumns: string[];
      textColumns: string[];
      supportColumns: string[];
      targetValueLabels: string[];
      taskSignals: TaskSignal[];
      modalitySignals: ModalitySignal[];
      intentSignals: string[];
      modality: 'text' | 'table' | 'hybrid';
    },
  ): string[] {
    const signals: string[] = [];

    if (dataset.rowCount <= 50) {
      signals.push(`small sample size (${dataset.rowCount} rows)`);
    }
    signals.push(`${dataset.taskType} task`);
    if (input.taskSignals.length > 0) {
      signals.push(`derived task signals: ${input.taskSignals.slice(0, 3).join(', ')}`);
    }
    if (input.modalitySignals.length > 0) {
      signals.push(`derived modality signals: ${input.modalitySignals.slice(0, 3).join(', ')}`);
    }

    if (input.targetValueLabels.length > 0) {
      signals.push(`target label values: ${input.targetValueLabels.slice(0, 4).join(', ')}`);
    }
    if (input.textColumns.length > 0) {
      signals.push(`core text features detected: ${input.textColumns.slice(0, 3).join(', ')}`);
    }
    if (input.supportColumns.some((column) => /topic|language|source/i.test(column))) {
      signals.push('source/topic/language style metadata available');
    }
    if (input.intentSignals.length > 0) {
      signals.push(`dataset intent points to ${input.intentSignals[0]}`);
    }
    if (analysis.missingStats.some((item) => item.missingRate > 0.25)) {
      const missingColumns = analysis.missingStats
        .filter((item) => item.missingRate > 0.25)
        .map((item) => `${item.column} (${(item.missingRate * 100).toFixed(1)}%)`);
      signals.push(`high-missing helper columns: ${missingColumns.slice(0, 2).join(', ')}`);
    }

    return uniqueKeepOrder(signals).slice(0, 6);
  }

  private resolveSelectedDomainIds(
    selectedDomains: string[],
    recommendation: DomainRecommendationResponse,
  ): string[] {
    const byId = new Map(domainCatalog.map((domain) => [domain.id.toLowerCase(), domain.id]));
    const byName = new Map(
      domainCatalog.flatMap((domain) => [
        [domain.title.toLowerCase(), domain.id] as const,
        ...((domain.aliases ?? []).map((alias) => [alias.toLowerCase(), domain.id] as const)),
      ]),
    );

    const resolved = selectedDomains
      .map((value) => {
        const normalized = value.trim().toLowerCase();
        return byId.get(normalized) ?? byName.get(normalized) ?? null;
      })
      .filter((value): value is string => value != null);

    if (resolved.length > 0) {
      return uniqueKeepOrder(resolved);
    }

    return recommendation.recommendedDomains.map((item) => item.id);
  }

  private collectMatches(source: Set<string>, target: Set<string>): string[] {
    return [...source].filter((token) => target.has(token));
  }
}
