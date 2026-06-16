import { Injectable } from '@nestjs/common';
import type {
  CollectedDatasetHit,
  CollectedKnowledgeHit,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
} from '../../common/contracts';
import type {
  DatasetDiscoveryHit,
  KnowledgeDiscoveryHit,
  RankedCandidate,
} from './types/collection-hit';

@Injectable()
export class CollectionNormalizerService {
  private readonly medicalSignals = [
    'clinical',
    'patient',
    'cohort',
    'visit',
    'outcome',
    'mortality',
    'adverse',
    'event',
    'ehr',
    'emr',
    'icu',
    'sepsis',
    'readmission',
  ];

  toRawKnowledgeHits(hits: KnowledgeDiscoveryHit[]): CollectedKnowledgeHit[] {
    return hits.map((hit) => ({
      id: hit.id,
      connector: hit.connector as CollectedKnowledgeHit['connector'],
      sourceType: hit.sourceType,
      layer: hit.layer,
      sourcePriority: hit.sourcePriority,
      sourceReliability: hit.sourceReliability,
      sourceClassification: hit.sourceClassification,
      sourceConfidence: hit.sourceConfidence,
      detectedHost: hit.detectedHost,
      routedConnector: hit.routedConnector as CollectedKnowledgeHit['routedConnector'],
      metadataCompleteness: hit.metadataCompleteness,
      extractionMethod: hit.extractionMethod,
      extractionReliability: hit.extractionReliability,
      title: hit.title,
      text: hit.text,
      tags: [...hit.tags],
      domainIds: [...hit.domainIds],
      taskSignals: [...hit.taskSignals],
      modalitySignals: [...hit.modalitySignals],
      modality: hit.modality,
      negativeTags: [...hit.negativeTags],
      matchedQueries: [...hit.matchedQueries],
      matchedTerms: [...hit.matchedTerms],
      source: hit.entry.source,
      sourceUrl: hit.entry.sourceUrl,
      publisher: hit.entry.publisher,
      retrievalHint: hit.entry.retrievalHint,
    }));
  }

  toRawDatasetHits(hits: DatasetDiscoveryHit[]): CollectedDatasetHit[] {
    return hits.map((hit) => ({
      id: hit.id,
      connector: hit.connector as CollectedDatasetHit['connector'],
      sourceType: hit.sourceType,
      layer: hit.layer,
      sourcePriority: hit.sourcePriority,
      sourceReliability: hit.sourceReliability,
      sourceClassification: hit.sourceClassification,
      sourceConfidence: hit.sourceConfidence,
      detectedHost: hit.detectedHost,
      routedConnector: hit.routedConnector as CollectedDatasetHit['routedConnector'],
      metadataCompleteness: hit.metadataCompleteness,
      extractionMethod: hit.extractionMethod,
      extractionReliability: hit.extractionReliability,
      directDownloadAvailable: hit.directDownloadAvailable,
      title: hit.title,
      text: hit.text,
      tags: [...hit.tags],
      domainIds: [...hit.domainIds],
      taskSignals: [...hit.taskSignals],
      modalitySignals: [...hit.modalitySignals],
      modality: hit.modality,
      negativeTags: [...hit.negativeTags],
      matchedQueries: [...hit.matchedQueries],
      matchedTerms: [...hit.matchedTerms],
      provider: hit.entry.provider,
      providerDetail: hit.entry.providerDetail,
      publisher: hit.entry.publisher,
      sourceUrl: hit.entry.sourceUrl,
      retrievalHint: hit.entry.retrievalHint,
      downloadUrl: hit.entry.downloadUrl,
      downloadMethod: hit.entry.downloadMethod,
      downloadHint: hit.entry.downloadHint,
      downloadReference: hit.entry.downloadReference,
    }));
  }

  normalizeKnowledge(hits: KnowledgeDiscoveryHit[]): ExternalKnowledgeItem[] {
    return hits.map((hit) => this.toKnowledgeItem(hit));
  }

  normalizeDatasets(hits: DatasetDiscoveryHit[]): ExternalDatasetItem[] {
    return hits.map((hit) => this.toDatasetItem(hit));
  }

  normalizeKnowledgeFromRanked(
    rankedHits: RankedCandidate<KnowledgeDiscoveryHit>[],
  ): ExternalKnowledgeItem[] {
    return rankedHits.map((entry) => {
      const item = this.toKnowledgeItem(entry.hit, entry.matchedKeywords, entry.matchedReason);
      return {
        ...item,
        score: Math.max(this.normalizeRankScore(entry.score), item.domainMatchScore ?? 0),
      };
    });
  }

  normalizeDatasetsFromRanked(
    rankedHits: RankedCandidate<DatasetDiscoveryHit>[],
  ): ExternalDatasetItem[] {
    return rankedHits.map((entry) => {
      const item = this.toDatasetItem(entry.hit, entry.matchedKeywords, entry.matchedReason);
      return {
        ...item,
        score: Math.max(this.normalizeRankScore(entry.score), item.domainMatchScore ?? 0),
      };
    });
  }

  private normalizeRankScore(rawScore: number): number {
    if (!Number.isFinite(rawScore)) return 0;
    return Math.max(0, Math.min(1, rawScore / 80));
  }

  private defaultMatchedReason(hit: KnowledgeDiscoveryHit | DatasetDiscoveryHit): string {
    const parts = [
      `Collected from ${hit.connector}`,
      hit.layer ? `layer=${hit.layer}` : '',
      hit.sourceType ? `type=${hit.sourceType}` : '',
      hit.sourceClassification ? `classification=${hit.sourceClassification}` : '',
      hit.routedConnector && hit.routedConnector !== hit.connector
        ? `rerouted=${hit.routedConnector}`
        : '',
      hit.extractionMethod ? `extraction=${hit.extractionMethod}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }

  private toKnowledgeItem(
    hit: KnowledgeDiscoveryHit,
    matchedKeywords?: string[],
    matchedReason?: string,
  ): ExternalKnowledgeItem {
    const scoreContext = this.computeMedicalContext([
      ...hit.matchedTerms,
      ...(matchedKeywords ?? []),
      ...hit.tags,
      hit.title,
      hit.text,
    ]);

    return {
      id: hit.entry.id,
      title: hit.entry.title,
      source: hit.entry.source,
      summary: hit.entry.summary,
      kind: hit.entry.kind,
      matchedKeywords: (matchedKeywords && matchedKeywords.length > 0
        ? [...matchedKeywords]
        : [...hit.matchedTerms]
      ).slice(0, 8),
      sourceUrl: hit.entry.sourceUrl,
      publisher: hit.entry.publisher,
      retrievalHint: hit.entry.retrievalHint,
      matchedReason: matchedReason || this.defaultMatchedReason(hit),
      layer: hit.layer,
      sourceClassification: hit.sourceClassification,
      sourceConfidence: hit.sourceConfidence,
      detectedHost: hit.detectedHost,
      routedConnector: hit.routedConnector as ExternalKnowledgeItem['routedConnector'],
      metadataCompleteness: hit.metadataCompleteness,
      extractionMethod: hit.extractionMethod,
      extractionReliability: hit.extractionReliability,
      domainMatchScore: scoreContext.score,
      medicalSignalsMatched: scoreContext.signals,
      reasonCodes: scoreContext.reasonCodes,
      nonMedicalPenaltyApplied: scoreContext.reasonCodes.includes('non_medical_signal_match'),
      excludedByMedicalGate: false,
    };
  }

  private toDatasetItem(
    hit: DatasetDiscoveryHit,
    matchedKeywords?: string[],
    matchedReason?: string,
  ): ExternalDatasetItem {
    const scoreContext = this.computeMedicalContext([
      ...hit.matchedTerms,
      ...(matchedKeywords ?? []),
      ...hit.tags,
      hit.title,
      hit.text,
    ]);

    return {
      id: hit.entry.id,
      name: hit.entry.name,
      provider: hit.entry.provider,
      description: hit.entry.description,
      rowsHint: hit.entry.rowsHint,
      modality: hit.entry.modality,
      licenseHint: hit.entry.licenseHint,
      matchedKeywords: (matchedKeywords && matchedKeywords.length > 0
        ? [...matchedKeywords]
        : [...hit.matchedTerms]
      ).slice(0, 8),
      sourceUrl: hit.entry.sourceUrl,
      providerDetail: hit.entry.providerDetail,
      publisher: hit.entry.publisher,
      retrievalHint: hit.entry.retrievalHint,
      downloadUrl: hit.entry.downloadUrl,
      downloadMethod: hit.entry.downloadMethod,
      downloadHint: hit.entry.downloadHint,
      downloadReference: hit.entry.downloadReference,
      matchedReason: matchedReason || this.defaultMatchedReason(hit),
      layer: hit.layer,
      sourceClassification: hit.sourceClassification,
      sourceConfidence: hit.sourceConfidence,
      detectedHost: hit.detectedHost,
      routedConnector: hit.routedConnector as ExternalDatasetItem['routedConnector'],
      metadataCompleteness: hit.metadataCompleteness,
      extractionMethod: hit.extractionMethod,
      extractionReliability: hit.extractionReliability,
      directDownloadAvailable: hit.directDownloadAvailable,
      domainMatchScore: scoreContext.score,
      medicalSignalsMatched: scoreContext.signals,
      reasonCodes: scoreContext.reasonCodes,
      nonMedicalPenaltyApplied: scoreContext.reasonCodes.includes('non_medical_signal_match'),
      excludedByMedicalGate: false,
    };
  }

  private computeMedicalContext(values: string[]): {
    score: number;
    signals: string[];
    reasonCodes: string[];
  } {
    const merged = values
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const matched = this.medicalSignals.filter((signal) => merged.includes(signal));
    const unique = [...new Set(matched)];
    const score = Math.min(1, unique.length / 6);
    const reasonCodes: string[] = [];
    const hasNonMedicalSignal = /(stock|ohlcv|fraud|authorship|essay|stylometry|predictive maintenance)/.test(merged);
    if (unique.length > 0) {
      reasonCodes.push('medical_signal_match');
    }
    if (hasNonMedicalSignal) {
      reasonCodes.push('non_medical_signal_match');
    }
    if (score >= 0.7) {
      reasonCodes.push('medical_high_confidence');
    } else if (score >= 0.4) {
      reasonCodes.push('medical_medium_confidence');
    } else {
      reasonCodes.push('medical_low_confidence');
    }
    return {
      score,
      signals: unique,
      reasonCodes,
    };
  }
}
