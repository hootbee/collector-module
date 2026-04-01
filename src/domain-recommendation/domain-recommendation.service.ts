import { Injectable } from '@nestjs/common';
import { domainCatalog } from '../common/catalog';
import type {
  DatasetAnalysisResponse,
  DatasetRecord,
  DiscoveryContext,
  DomainDatasetSummary,
  DomainRecommendationResponse,
  RecommendedDomain,
} from '../common/contracts';
import { stableHash, tokenize, uniqueKeepOrder } from '../common/text';
import { ProfilingService } from '../profiling/profiling.service';

@Injectable()
export class DomainRecommendationService {
  constructor(private readonly profilingService: ProfilingService) {}

  buildDatasetSummary(dataset: DatasetRecord, metadataColumns: string[]): DomainDatasetSummary {
    const features = this.featureColumns(dataset, metadataColumns);
    return {
      fileName: dataset.fileName,
      rowCount: dataset.rowCount,
      colCount: dataset.colCount,
      taskType: dataset.taskType,
      metaColumns: [...metadataColumns],
      featureColumnCount: features.length,
      targetColumns: [...dataset.targetColumns],
      description: dataset.description,
    };
  }

  recommendDataset(input: {
    dataset: DatasetRecord;
    metadataColumns?: string[];
    refreshSeed?: number;
  }): DomainRecommendationResponse {
    const metadataColumns = input.metadataColumns ?? [];
    const analysis = input.dataset.analysis ?? this.profilingService.analyzeDataset(input.dataset);
    const extractedKeywords = this.topKeywords(input.dataset, metadataColumns, analysis);
    const keywordSet = new Set(tokenize(extractedKeywords.join(' ')));
    const columnTokens = new Set(tokenize(input.dataset.columns.join(' ')));
    const descriptionTokens = new Set(tokenize(input.dataset.description));
    const refreshSeed = input.refreshSeed ?? 0;

    const candidates = domainCatalog
      .map((domain) => {
        const domainTokens = new Set(tokenize(domain.keywords.join(' '), domain.title));
        let score = [...keywordSet].filter((token) => domainTokens.has(token)).length;
        score += [...columnTokens].filter((token) => domainTokens.has(token)).length * 0.6;
        score += [...descriptionTokens].filter((token) => domainTokens.has(token)).length * 0.9;

        const matchedTerms = uniqueKeepOrder(
          domain.keywords.filter(
            (keyword) => keywordSet.has(keyword.toLowerCase()) || columnTokens.has(keyword.toLowerCase()),
          ),
        );

        if (
          (input.dataset.taskType === 'classification' || input.dataset.taskType === 'anomaly') &&
          ['dom-medical', 'dom-finance', 'dom-industrial'].includes(domain.id)
        ) {
          score += 0.7;
        }

        if (
          input.dataset.taskType === 'regression' &&
          ['dom-bio', 'dom-environment', 'dom-industrial'].includes(domain.id)
        ) {
          score += 0.7;
        }

        const featureBlob = this.featureColumns(input.dataset, metadataColumns).join(' ').toLowerCase();
        if (
          /(sensor|temp|press|rpm)/.test(featureBlob) &&
          domain.id === 'dom-industrial'
        ) {
          score += 1.5;
        }

        const columnBlob = input.dataset.columns.join(' ').toLowerCase();
        if (/(patient|drug|adverse|lab)/.test(columnBlob) && ['dom-medical', 'dom-bio'].includes(domain.id)) {
          score += 1.6;
        }
        if (/(transaction|account|merchant)/.test(columnBlob) && domain.id === 'dom-finance') {
          score += 1.8;
        }
        if (/(air|water|weather|station)/.test(columnBlob) && domain.id === 'dom-environment') {
          score += 1.8;
        }

        const jitter = stableHash(`${domain.id}:${refreshSeed}`) / 1_000_000_000;
        const relevance =
          score >= 4.2 ? 'high' : score >= 2.2 ? 'medium' : 'low';

        const reasons: string[] = [];
        if (matchedTerms.length > 0) {
          reasons.push(`keyword match: ${matchedTerms.slice(0, 4).join(', ')}`);
        }
        if (input.dataset.taskType === 'classification' || input.dataset.taskType === 'anomaly') {
          reasons.push('task suggests sparse label or anomaly style search');
        }
        if (input.dataset.taskType === 'regression') {
          reasons.push('task suggests continuous target prediction context');
        }

        const domainResult: RecommendedDomain = {
          id: domain.id,
          name: domain.title,
          shortDescription: domain.shortDescription,
          recommendationReason: `${reasons.join(' / ') || 'weak structural overlap detected'}; taskType=${input.dataset.taskType}`,
          keywords: matchedTerms.slice(0, 5).length > 0 ? matchedTerms.slice(0, 5) : domain.keywords.slice(0, 4),
          relevance,
        };

        return { score, jitter, domainResult };
      })
      .filter((item) => item.score > 0);

    const ranked = (candidates.length > 0 ? candidates : domainCatalog.map((domain) => ({
      score: 0.1,
      jitter: stableHash(`${domain.id}:${refreshSeed}`) / 1_000_000_000,
      domainResult: {
        id: domain.id,
        name: domain.title,
        shortDescription: domain.shortDescription,
        recommendationReason: 'general table-shaped fallback candidate',
        keywords: domain.keywords.slice(0, 4),
        relevance: 'low' as const,
      },
    })))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.jitter - right.jitter;
      })
      .slice(0, 5)
      .map((item) => item.domainResult);

    const evidenceSummary = {
      extractedKeywords,
      influentialFeatureColumns: this.featureColumns(input.dataset, metadataColumns).slice(0, 6),
      influentialTargetColumns: [...input.dataset.targetColumns].slice(0, 4),
      descriptionSignals: this.descriptionSignals(input.dataset, metadataColumns, analysis),
    };

    const expandedKeywords = uniqueKeepOrder([
      ...extractedKeywords,
      ...ranked.flatMap((domain) => domain.keywords),
      ...metadataColumns,
      ...input.dataset.targetColumns,
    ]).slice(0, 18);

    const generatedQueries = ranked.slice(0, 3).map((domain) =>
      [domain.name, input.dataset.taskType, input.dataset.description.trim(), 'public dataset']
        .filter(Boolean)
        .join(' ')
        .slice(0, 180),
    );

    return {
      sessionId: input.dataset.sessionId,
      datasetId: input.dataset.id,
      datasetSummary: this.buildDatasetSummary(input.dataset, metadataColumns),
      evidenceSummary,
      recommendedDomains: ranked,
      expandedKeywords,
      generatedQueries,
    };
  }

  buildDiscoveryContext(input: {
    dataset: DatasetRecord;
    metadataColumns: string[];
    selectedDomains: string[];
  }): DiscoveryContext {
    const recommendation =
      input.dataset.recommendation ?? this.recommendDataset({ dataset: input.dataset, metadataColumns: input.metadataColumns });

    return {
      dataset: input.dataset,
      selectedDomains: [...input.selectedDomains],
      metadataColumns: [...input.metadataColumns],
      expandedKeywords: [...recommendation.expandedKeywords],
      generatedQueries: [...recommendation.generatedQueries],
    };
  }

  private featureColumns(dataset: DatasetRecord, metadataColumns: string[]): string[] {
    const metadataSet = new Set(metadataColumns);
    const targetSet = new Set(dataset.targetColumns);
    return dataset.columns.filter((column) => !metadataSet.has(column) && !targetSet.has(column));
  }

  private topKeywords(
    dataset: DatasetRecord,
    metadataColumns: string[],
    analysis: DatasetAnalysisResponse,
  ): string[] {
    const tokenCounts = new Map<string, number>();
    for (const token of tokenize(
      dataset.description,
      dataset.fileName,
      dataset.columns.join(' '),
      dataset.targetColumns.join(' '),
      metadataColumns.join(' '),
    )) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }

    const preferred = [...tokenCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([token]) => token);

    const merged = [
      ...preferred,
      ...dataset.targetColumns,
      ...this.featureColumns(dataset, metadataColumns).slice(0, 6),
    ];

    if (dataset.taskType === 'classification') {
      merged.push('classification', 'class imbalance');
    } else if (dataset.taskType === 'anomaly') {
      merged.push('anomaly detection', 'rare event');
    } else {
      merged.push('regression', 'numeric target');
    }

    if (analysis.imbalanceSummary.some((item) => item.stat?.isHighlyImbalanced)) {
      merged.push('imbalance');
    }

    return uniqueKeepOrder(merged).slice(0, 12);
  }

  private descriptionSignals(
    dataset: DatasetRecord,
    metadataColumns: string[],
    analysis: DatasetAnalysisResponse,
  ): string[] {
    const signals: string[] = [];

    if (dataset.description.trim()) {
      signals.push('user description and structural columns were combined for rule-based inference');
    }

    if (metadataColumns.length > 0) {
      signals.push(`${metadataColumns.length} zero-missing non-target columns were treated as metadata candidates`);
    }

    const highlyImbalanced = analysis.imbalanceSummary
      .filter((item) => item.stat?.isHighlyImbalanced)
      .map((item) => item.col);
    if (highlyImbalanced.length > 0) {
      signals.push(`sparse target distribution detected for ${highlyImbalanced.join(', ')}`);
    }

    const timeLike = dataset.columns.filter((column) => /(date|time|visit|month)/i.test(column));
    if (timeLike.length > 0) {
      signals.push(`time or visit style columns found: ${timeLike.slice(0, 3).join(', ')}`);
    }

    return signals.slice(0, 4);
  }
}
