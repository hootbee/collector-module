import { Injectable } from '@nestjs/common';
import type { ExternalDatasetItem, ExternalKnowledgeItem } from '../common/contracts';
import type {
  DatasetDiscoveryHit,
  KnowledgeDiscoveryHit,
  RankedDiscoveryHit,
} from './types/discovery-hit';

@Injectable()
export class DiscoveryNormalizerService {
  normalizeKnowledge(items: RankedDiscoveryHit<KnowledgeDiscoveryHit>[]): ExternalKnowledgeItem[] {
    return items.map(({ hit, score, matchedKeywords, matchedReason }) => ({
      id: hit.entry.id,
      title: hit.entry.title,
      source: hit.entry.source,
      summary: hit.entry.summary,
      kind: hit.entry.kind,
      matchedKeywords: matchedKeywords.slice(0, 6),
      sourceUrl: hit.entry.sourceUrl,
      publisher: hit.entry.publisher,
      retrievalHint: hit.entry.retrievalHint,
      score: Number(score.toFixed(3)),
      matchedReason,
    }));
  }

  normalizeDatasets(items: RankedDiscoveryHit<DatasetDiscoveryHit>[]): ExternalDatasetItem[] {
    return items.map(({ hit, score, matchedKeywords, matchedReason }) => ({
      id: hit.entry.id,
      name: hit.entry.name,
      provider: hit.entry.provider,
      description: hit.entry.description,
      rowsHint: hit.entry.rowsHint,
      modality: hit.entry.modality,
      licenseHint: hit.entry.licenseHint,
      matchedKeywords: matchedKeywords.slice(0, 6),
      sourceUrl: hit.entry.sourceUrl,
      providerDetail: hit.entry.providerDetail,
      publisher: hit.entry.publisher,
      retrievalHint: hit.entry.retrievalHint,
      score: Number(score.toFixed(3)),
      matchedReason,
    }));
  }
}
