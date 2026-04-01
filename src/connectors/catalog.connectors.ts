import { Injectable } from '@nestjs/common';
import { datasetCatalog, knowledgeCatalog } from '../common/catalog';
import type {
  DatasetCatalogEntry,
  DiscoveryContext,
  ExternalDatasetItem,
  ExternalKnowledgeItem,
  KnowledgeCatalogEntry,
} from '../common/contracts';
import { tokenize, uniqueKeepOrder } from '../common/text';

function scoreCatalogItem(
  keywords: Set<string>,
  text: string,
  tags: string[],
): { score: number; matchedKeywords: string[] } {
  const textTokens = new Set(tokenize(text));
  const tagTokens = new Set(tokenize(tags.join(' ')));
  const matchedKeywords = uniqueKeepOrder(
    tags.filter((tag) => keywords.has(tag.toLowerCase()) || textTokens.has(tag.toLowerCase())),
  );

  const score =
    [...keywords].filter((token) => tagTokens.has(token)).length * 4 +
    [...keywords].filter((token) => textTokens.has(token)).length;

  return { score, matchedKeywords };
}

@Injectable()
export class CatalogConnectorsService {
  searchKnowledge(context: DiscoveryContext): ExternalKnowledgeItem[] {
    const keywords = new Set(
      tokenize(
        context.expandedKeywords.join(' '),
        context.selectedDomains.join(' '),
        context.generatedQueries.join(' '),
      ),
    );

    return knowledgeCatalog
      .map((item) => this.mapKnowledgeItem(item, keywords))
      .filter((item): item is { score: number; value: ExternalKnowledgeItem } => item != null)
      .sort((left, right) => right.score - left.score || left.value.id.localeCompare(right.value.id))
      .slice(0, 8)
      .map((item) => item.value);
  }

  searchDatasets(context: DiscoveryContext): ExternalDatasetItem[] {
    const keywords = new Set(
      tokenize(
        context.expandedKeywords.join(' '),
        context.selectedDomains.join(' '),
        context.generatedQueries.join(' '),
      ),
    );

    return datasetCatalog
      .map((item) => this.mapDatasetItem(item, keywords))
      .filter((item): item is { score: number; value: ExternalDatasetItem } => item != null)
      .sort((left, right) => right.score - left.score || left.value.id.localeCompare(right.value.id))
      .slice(0, 8)
      .map((item) => item.value);
  }

  private mapKnowledgeItem(
    item: KnowledgeCatalogEntry,
    keywords: Set<string>,
  ): { score: number; value: ExternalKnowledgeItem } | null {
    const { score, matchedKeywords } = scoreCatalogItem(
      keywords,
      `${item.title} ${item.summary} ${item.source}`,
      item.tags,
    );

    if (score <= 0) {
      return null;
    }

    return {
      score,
      value: {
        id: item.id,
        title: item.title,
        source: item.source,
        summary: item.summary,
        kind: item.kind,
        matchedKeywords: matchedKeywords.slice(0, 5).length > 0 ? matchedKeywords.slice(0, 5) : item.tags.slice(0, 3),
      },
    };
  }

  private mapDatasetItem(
    item: DatasetCatalogEntry,
    keywords: Set<string>,
  ): { score: number; value: ExternalDatasetItem } | null {
    const { score, matchedKeywords } = scoreCatalogItem(
      keywords,
      `${item.name} ${item.description} ${item.provider} ${item.modality}`,
      item.tags,
    );

    if (score <= 0) {
      return null;
    }

    return {
      score,
      value: {
        id: item.id,
        name: item.name,
        provider: item.provider,
        description: item.description,
        rowsHint: item.rowsHint,
        modality: item.modality,
        licenseHint: item.licenseHint,
        matchedKeywords: matchedKeywords.slice(0, 5).length > 0 ? matchedKeywords.slice(0, 5) : item.tags.slice(0, 3),
      },
    };
  }
}
