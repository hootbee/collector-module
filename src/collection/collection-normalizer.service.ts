import { Injectable } from '@nestjs/common';
import type {
  CollectedDatasetHit,
  CollectedKnowledgeHit,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
} from '../common/contracts';
import type { DatasetDiscoveryHit, KnowledgeDiscoveryHit } from './types/collection-hit';

@Injectable()
export class CollectionNormalizerService {
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
    const seen = new Set<string>();
    return this.sortHits(hits)
      .flatMap((hit) => {
        const dedupeKey = hit.entry.sourceUrl?.trim().toLowerCase() || `${hit.entry.source.toLowerCase()}:${hit.title.toLowerCase()}`;
        if (seen.has(dedupeKey)) {
          return [];
        }
        seen.add(dedupeKey);
        return [{
          id: hit.entry.id,
          title: hit.entry.title,
          source: hit.entry.source,
          summary: hit.entry.summary,
          kind: hit.entry.kind,
          matchedKeywords: [...hit.matchedTerms].slice(0, 8),
          sourceUrl: hit.entry.sourceUrl,
          publisher: hit.entry.publisher,
          retrievalHint: hit.entry.retrievalHint,
          matchedReason: this.matchedReason(hit),
          layer: hit.layer,
          sourceClassification: hit.sourceClassification,
          sourceConfidence: hit.sourceConfidence,
          detectedHost: hit.detectedHost,
          routedConnector: hit.routedConnector as ExternalKnowledgeItem['routedConnector'],
          metadataCompleteness: hit.metadataCompleteness,
          extractionMethod: hit.extractionMethod,
          extractionReliability: hit.extractionReliability,
        }];
      });
  }

  normalizeDatasets(hits: DatasetDiscoveryHit[]): ExternalDatasetItem[] {
    const seen = new Set<string>();
    return this.sortHits(hits)
      .flatMap((hit) => {
        const dedupeKey = hit.entry.sourceUrl?.trim().toLowerCase() || `${hit.entry.provider.toLowerCase()}:${hit.title.toLowerCase()}`;
        if (seen.has(dedupeKey)) {
          return [];
        }
        seen.add(dedupeKey);
        return [{
          id: hit.entry.id,
          name: hit.entry.name,
          provider: hit.entry.provider,
          description: hit.entry.description,
          rowsHint: hit.entry.rowsHint,
          modality: hit.entry.modality,
          licenseHint: hit.entry.licenseHint,
          matchedKeywords: [...hit.matchedTerms].slice(0, 8),
          sourceUrl: hit.entry.sourceUrl,
          providerDetail: hit.entry.providerDetail,
          publisher: hit.entry.publisher,
          retrievalHint: hit.entry.retrievalHint,
          downloadUrl: hit.entry.downloadUrl,
          downloadMethod: hit.entry.downloadMethod,
          downloadHint: hit.entry.downloadHint,
          downloadReference: hit.entry.downloadReference,
          matchedReason: this.matchedReason(hit),
          layer: hit.layer,
          sourceClassification: hit.sourceClassification,
          sourceConfidence: hit.sourceConfidence,
          detectedHost: hit.detectedHost,
          routedConnector: hit.routedConnector as ExternalDatasetItem['routedConnector'],
          metadataCompleteness: hit.metadataCompleteness,
          extractionMethod: hit.extractionMethod,
          extractionReliability: hit.extractionReliability,
          directDownloadAvailable: hit.directDownloadAvailable,
        }];
      });
  }

  private sortHits<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(hits: T[]): T[] {
    return [...hits].sort((left, right) => {
      const leftScore = this.sortScore(left);
      const rightScore = this.sortScore(right);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      if (right.sourcePriority !== left.sourcePriority) {
        return right.sourcePriority - left.sourcePriority;
      }
      if (right.sourceReliability !== left.sourceReliability) {
        return right.sourceReliability - left.sourceReliability;
      }
      return this.canonicalTitle(left.title).localeCompare(this.canonicalTitle(right.title));
    });
  }

  private sortScore(hit: KnowledgeDiscoveryHit | DatasetDiscoveryHit): number {
    let score = 0;
    if (hit.layer === 'structured') {
      score += 40;
    }
    if (hit.sourceClassification === 'known') {
      score += 25;
    } else if (hit.sourceClassification === 'unknown') {
      score -= 12;
    }
    if (hit.directDownloadAvailable) {
      score += 4;
    }
    if (hit.kind === 'dataset' && hit.entry.downloadUrl?.trim()) {
      score += 2;
    }
    score += (hit.metadataCompleteness ?? 0) * 10;
    if (hit.extractionMethod === 'browser') {
      score -= 4;
    }
    if (hit.extractionMethod === 'html') {
      score -= 1;
    }
    score += hit.sourcePriority * 10;
    score += hit.sourceReliability * 10;
    return score;
  }

  private matchedReason(hit: KnowledgeDiscoveryHit | DatasetDiscoveryHit): string {
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

  private canonicalTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
}
