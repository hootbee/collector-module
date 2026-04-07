import { Injectable } from '@nestjs/common';
import type {
  CollectedDatasetHit,
  CollectedKnowledgeHit,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
} from '../common/contracts';
import type { DatasetDiscoveryHit, KnowledgeDiscoveryHit } from '../discovery/types/discovery-hit';

@Injectable()
export class CollectionNormalizerService {
  toRawKnowledgeHits(hits: KnowledgeDiscoveryHit[]): CollectedKnowledgeHit[] {
    return hits.map((hit) => ({
      id: hit.id,
      connector: hit.connector as CollectedKnowledgeHit['connector'],
      sourceType: hit.sourceType,
      sourcePriority: hit.sourcePriority,
      sourceReliability: hit.sourceReliability,
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
      sourcePriority: hit.sourcePriority,
      sourceReliability: hit.sourceReliability,
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
          matchedReason: `Collected from ${hit.connector} (${hit.sourceType})`,
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
          matchedReason: `Collected from ${hit.connector} (${hit.sourceType})`,
        }];
      });
  }

  private sortHits<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit>(hits: T[]): T[] {
    return [...hits].sort((left, right) => {
      if (right.sourcePriority !== left.sourcePriority) {
        return right.sourcePriority - left.sourcePriority;
      }
      if (right.sourceReliability !== left.sourceReliability) {
        return right.sourceReliability - left.sourceReliability;
      }
      return left.id.localeCompare(right.id);
    });
  }
}
