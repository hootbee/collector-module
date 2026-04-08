import { Injectable } from '@nestjs/common';
import { nowIso } from '../common/time';
import type {
  CollectionExtractionMethod,
  CollectionSourceClassification,
  CollectionSourceConfidence,
  CollectionSourceId,
} from '../common/contracts';
import {
  buildDatasetEntry,
  buildKnowledgeEntry,
  collapseWhitespace,
  fetchText,
  stripHtml,
} from './connectors/connector.utils';
import {
  detectKnownSource,
  genericFetchLimit,
} from './collection-layer.config';
import type {
  DatasetDiscoveryHit,
  FetchedDocument,
  KnowledgeDiscoveryHit,
  RoutedHit,
} from './types/collection-hit';

type ProcessingOutcome<T extends KnowledgeDiscoveryHit | DatasetDiscoveryHit> = {
  hits: T[];
  routedHits: RoutedHit[];
  fetchedDocuments: FetchedDocument[];
};

type ExtractedHtmlMetadata = {
  title?: string;
  description?: string;
  publisher?: string;
  licenseHint?: string;
  directDownloadAvailable: boolean;
  linkCandidates: string[];
  downloadUrl?: string;
};

@Injectable()
export class CollectionWebRoutingService {
  async annotateStructuredKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
  ): Promise<ProcessingOutcome<KnowledgeDiscoveryHit>> {
    return this.processKnowledgeHits(hits, 'structured');
  }

  async routeGenericKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
  ): Promise<ProcessingOutcome<KnowledgeDiscoveryHit>> {
    return this.processKnowledgeHits(hits, 'generic');
  }

  async annotateStructuredDatasetHits(
    hits: DatasetDiscoveryHit[],
  ): Promise<ProcessingOutcome<DatasetDiscoveryHit>> {
    return this.processDatasetHits(hits, 'structured');
  }

  async routeGenericDatasetHits(
    hits: DatasetDiscoveryHit[],
  ): Promise<ProcessingOutcome<DatasetDiscoveryHit>> {
    return this.processDatasetHits(hits, 'generic');
  }

  private async processKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
    layer: 'structured' | 'generic',
  ): Promise<ProcessingOutcome<KnowledgeDiscoveryHit>> {
    const routedHits: RoutedHit[] = [];
    const fetchedDocuments: FetchedDocument[] = [];
    let fetchBudget = genericFetchLimit();

    const enriched = await Promise.all(
      hits.map(async (hit) => {
        const url = hit.entry.sourceUrl;
        const {
          detectedHost,
          routedConnector,
          sourceConfidence: detectedConfidence,
        } = layer === 'structured'
          ? {
              detectedHost: this.hostFromUrl(url),
              routedConnector: hit.connector as CollectionSourceId,
              sourceConfidence: this.structuredConfidence(hit.connector as CollectionSourceId),
            }
          : detectKnownSource(url);
        const sourceClassification: CollectionSourceClassification =
          layer === 'structured' || routedConnector ? 'known' : 'unknown';
        const sourceConfidence: CollectionSourceConfidence =
          layer === 'structured'
            ? this.structuredConfidence(hit.connector as CollectionSourceId)
            : routedConnector
              ? detectedConfidence
              : 'low';
        const rerouted = layer === 'generic' && Boolean(routedConnector);

        routedHits.push({
          sourceHitId: hit.id,
          kind: hit.kind,
          connector: hit.connector as CollectionSourceId,
          layer,
          url,
          detectedHost,
          sourceClassification,
          sourceConfidence,
          routedConnector,
          rerouted,
        });

        let updatedHit: KnowledgeDiscoveryHit = {
          ...hit,
          layer,
          sourceClassification,
          sourceConfidence,
          detectedHost,
          routedConnector,
          extractionMethod: layer === 'structured' ? 'direct' : undefined,
          extractionReliability: layer === 'structured' ? hit.sourceReliability : 0.65,
        };

        if (layer === 'generic' && sourceClassification === 'unknown' && url && fetchBudget > 0) {
          fetchBudget -= 1;
          const fetched = await this.tryFetchDocument(hit.id, url, 'html');
          if (fetched) {
            fetchedDocuments.push(fetched.document);
            updatedHit = {
              ...updatedHit,
              entry: buildKnowledgeEntry({
                ...updatedHit.entry,
                title: fetched.metadata.title || updatedHit.entry.title,
                summary: fetched.metadata.description || updatedHit.entry.summary,
                source: updatedHit.entry.source || fetched.metadata.publisher || detectedHost || 'web',
                publisher: fetched.metadata.publisher || updatedHit.entry.publisher,
                retrievalHint: this.joinHints(
                  updatedHit.entry.retrievalHint,
                  `Generic HTML extraction from ${detectedHost || 'web'}`,
                ),
                tags: [
                  ...updatedHit.entry.tags,
                  ...(fetched.metadata.linkCandidates ?? []),
                ],
              }),
              text: `${fetched.metadata.title || updatedHit.title} ${fetched.metadata.description || updatedHit.text}`,
              extractionMethod: 'html',
              extractionReliability: 0.58,
            };
          }
        }

        return {
          ...updatedHit,
          metadataCompleteness: this.knowledgeCompleteness(updatedHit),
        };
      }),
    );

    return {
      hits: enriched,
      routedHits,
      fetchedDocuments,
    };
  }

  private async processDatasetHits(
    hits: DatasetDiscoveryHit[],
    layer: 'structured' | 'generic',
  ): Promise<ProcessingOutcome<DatasetDiscoveryHit>> {
    const routedHits: RoutedHit[] = [];
    const fetchedDocuments: FetchedDocument[] = [];
    let fetchBudget = genericFetchLimit();

    const enriched = await Promise.all(
      hits.map(async (hit) => {
        const url = hit.entry.sourceUrl;
        const {
          detectedHost,
          routedConnector,
          sourceConfidence: detectedConfidence,
        } = layer === 'structured'
          ? {
              detectedHost: this.hostFromUrl(url),
              routedConnector: hit.connector as CollectionSourceId,
              sourceConfidence: this.structuredConfidence(hit.connector as CollectionSourceId),
            }
          : detectKnownSource(url);
        const sourceClassification: CollectionSourceClassification =
          layer === 'structured' || routedConnector ? 'known' : 'unknown';
        const sourceConfidence: CollectionSourceConfidence =
          layer === 'structured'
            ? this.structuredConfidence(hit.connector as CollectionSourceId)
            : routedConnector
              ? detectedConfidence
              : 'low';
        const rerouted = layer === 'generic' && Boolean(routedConnector);

        routedHits.push({
          sourceHitId: hit.id,
          kind: hit.kind,
          connector: hit.connector as CollectionSourceId,
          layer,
          url,
          detectedHost,
          sourceClassification,
          sourceConfidence,
          routedConnector,
          rerouted,
        });

        let updatedHit: DatasetDiscoveryHit = {
          ...hit,
          layer,
          sourceClassification,
          sourceConfidence,
          detectedHost,
          routedConnector,
          extractionMethod: layer === 'structured' ? 'direct' : undefined,
          extractionReliability: layer === 'structured' ? hit.sourceReliability : 0.65,
          directDownloadAvailable:
            this.hasDirectDownloadSuffix(url) || hit.directDownloadAvailable,
        };

        if (layer === 'generic' && sourceClassification === 'known' && routedConnector) {
          updatedHit = {
            ...updatedHit,
            entry: buildDatasetEntry({
              ...updatedHit.entry,
              provider: this.providerLabelForConnector(routedConnector),
              downloadUrl:
                updatedHit.entry.downloadUrl ||
                this.knownSourceDownloadUrl(routedConnector, updatedHit.entry.sourceUrl),
              downloadMethod:
                updatedHit.entry.downloadMethod ||
                this.knownSourceDownloadMethod(routedConnector),
              downloadHint:
                updatedHit.entry.downloadHint ||
                this.knownSourceDownloadHint(routedConnector, updatedHit.entry.sourceUrl),
              downloadReference:
                updatedHit.entry.downloadReference ||
                this.knownSourceDownloadReference(routedConnector, updatedHit.entry.sourceUrl),
              retrievalHint: this.joinHints(
                updatedHit.entry.retrievalHint,
                `Generic result rerouted to ${routedConnector}`,
              ),
            }),
          };
        }

        if (layer === 'generic' && sourceClassification === 'unknown' && url && fetchBudget > 0) {
          fetchBudget -= 1;
          const fetched = await this.tryFetchDocument(hit.id, url, 'html');
          if (fetched) {
            fetchedDocuments.push(fetched.document);
            updatedHit = {
              ...updatedHit,
              entry: buildDatasetEntry({
                ...updatedHit.entry,
                name: fetched.metadata.title || updatedHit.entry.name,
                provider: updatedHit.entry.provider || detectedHost || 'web',
                description: fetched.metadata.description || updatedHit.entry.description,
                licenseHint: fetched.metadata.licenseHint || updatedHit.entry.licenseHint,
                downloadUrl: fetched.metadata.downloadUrl || updatedHit.entry.downloadUrl || updatedHit.entry.sourceUrl,
                downloadMethod:
                  fetched.metadata.downloadUrl
                    ? 'direct'
                    : updatedHit.entry.downloadMethod || 'source-page',
                downloadHint:
                  fetched.metadata.downloadUrl
                    ? 'Direct file URL discovered during generic HTML extraction.'
                    : updatedHit.entry.downloadHint || 'Open the source page and inspect dataset or download links.',
                downloadReference:
                  fetched.metadata.downloadUrl || updatedHit.entry.downloadReference || updatedHit.entry.sourceUrl,
                retrievalHint: this.joinHints(
                  updatedHit.entry.retrievalHint,
                  `Generic HTML extraction from ${detectedHost || 'web'}`,
                ),
                tags: [
                  ...updatedHit.entry.tags,
                  ...(fetched.metadata.linkCandidates ?? []),
                ],
              }),
              text: `${fetched.metadata.title || updatedHit.title} ${fetched.metadata.description || updatedHit.text}`,
              extractionMethod: 'html',
              extractionReliability: 0.56,
              directDownloadAvailable:
                fetched.metadata.directDownloadAvailable || updatedHit.directDownloadAvailable,
            };
          }
        }

        return {
          ...updatedHit,
          metadataCompleteness: this.datasetCompleteness(updatedHit),
        };
      }),
    );

    return {
      hits: enriched,
      routedHits,
      fetchedDocuments,
    };
  }

  private async tryFetchDocument(
    sourceHitId: string,
    url: string,
    extractionMethod: CollectionExtractionMethod,
  ): Promise<{ document: FetchedDocument; metadata: ExtractedHtmlMetadata } | null> {
    try {
      const html = await fetchText(url);
      const metadata = this.extractHtmlMetadata(html, url);
      return {
        document: {
          sourceHitId,
          url,
          finalUrl: url,
          extractedText: collapseWhitespace(stripHtml(html)).slice(0, 4000),
          metadata,
          extractionMethod,
          retrievedAt: nowIso(),
        },
        metadata,
      };
    } catch {
      return null;
    }
  }

  private extractHtmlMetadata(html: string, pageUrl: string): ExtractedHtmlMetadata {
    const title =
      this.extractMetaContent(html, 'property', 'og:title') ||
      this.extractMetaContent(html, 'name', 'twitter:title') ||
      this.extractTagText(html, 'title');
    const description =
      this.extractMetaContent(html, 'name', 'description') ||
      this.extractMetaContent(html, 'property', 'og:description') ||
      collapseWhitespace(stripHtml(html)).slice(0, 320);
    const publisher =
      this.extractMetaContent(html, 'name', 'author') ||
      this.extractMetaContent(html, 'property', 'article:publisher');
    const licenseHint = this.extractLicenseHint(html);
    const linkCandidates = this.extractLinkCandidates(html, pageUrl);

    return {
      title: title ? collapseWhitespace(title).slice(0, 180) : undefined,
      description: description ? collapseWhitespace(description).slice(0, 320) : undefined,
      publisher: publisher ? collapseWhitespace(publisher).slice(0, 140) : undefined,
      licenseHint,
      directDownloadAvailable: linkCandidates.some((candidate) => this.hasDirectDownloadSuffix(candidate)),
      linkCandidates,
      downloadUrl: linkCandidates.find((candidate) => this.hasDirectDownloadSuffix(candidate)),
    };
  }

  private extractMetaContent(html: string, attribute: 'name' | 'property', value: string): string | undefined {
    const pattern = new RegExp(
      `<meta[^>]+${attribute}=["']${value}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    );
    const reversePattern = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${value}["'][^>]*>`,
      'i',
    );
    return pattern.exec(html)?.[1] || reversePattern.exec(html)?.[1] || undefined;
  }

  private extractTagText(html: string, tagName: string): string | undefined {
    const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(html);
    return match?.[1] ? stripHtml(match[1]) : undefined;
  }

  private extractLicenseHint(html: string): string | undefined {
    const text = collapseWhitespace(stripHtml(html)).toLowerCase();
    const match = text.match(/license[:\s]+([a-z0-9 .,+-]{3,80})/i);
    return match?.[1] ? collapseWhitespace(match[1]) : undefined;
  }

  private extractLinkCandidates(html: string, pageUrl: string): string[] {
    const matches = [...html.matchAll(/href=["']([^"']+)["']/gi)];
    const base = (() => {
      try {
        return new URL(pageUrl);
      } catch {
        return null;
      }
    })();

    const links = matches
      .map((match) => match[1]?.trim())
      .filter(Boolean)
      .map((href) => {
        if (!href) {
          return '';
        }
        if (/^https?:\/\//i.test(href)) {
          return href;
        }
        if (!base) {
          return href;
        }
        try {
          return new URL(href, base).toString();
        } catch {
          return href;
        }
      })
      .filter((candidate) =>
        /\.(csv|tsv|json|jsonl|zip|gz|parquet|xlsx?)($|\?)/i.test(candidate) ||
        /download|dataset|datafile|resource/i.test(candidate),
      );

    return [...new Set(links)].slice(0, 8);
  }

  private hostFromUrl(url?: string): string | undefined {
    if (!url) {
      return undefined;
    }
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return undefined;
    }
  }

  private hasDirectDownloadSuffix(url?: string): boolean {
    if (!url) {
      return false;
    }
    return /\.(csv|tsv|json|jsonl|zip|gz|parquet|xlsx?)($|\?)/i.test(url);
  }

  private structuredConfidence(connector: CollectionSourceId): CollectionSourceConfidence {
    if (connector === 'huggingface' || connector === 'openml' || connector === 'crossref') {
      return 'high';
    }
    if (connector === 'kaggle' || connector === 'uci' || connector === 'seed-catalog') {
      return 'medium';
    }
    return 'low';
  }

  private providerLabelForConnector(connector: CollectionSourceId): string {
    switch (connector) {
      case 'huggingface':
        return 'Hugging Face';
      case 'kaggle':
        return 'Kaggle';
      case 'openml':
        return 'OpenML';
      case 'uci':
        return 'UCI Machine Learning Repository';
      default:
        return connector;
    }
  }

  private knowledgeCompleteness(hit: KnowledgeDiscoveryHit): number {
    let score = 0;
    const entry = hit.entry;
    if (entry.title?.trim()) score += 1;
    if (entry.summary?.trim()) score += 1;
    if (entry.source?.trim()) score += 1;
    if (entry.sourceUrl?.trim()) score += 1;
    if (entry.publisher?.trim()) score += 1;
    if (entry.retrievalHint?.trim()) score += 0.5;
    return Math.min(1, score / 5.5);
  }

  private datasetCompleteness(hit: DatasetDiscoveryHit): number {
    let score = 0;
    const entry = hit.entry;
    if (entry.name?.trim()) score += 1;
    if (entry.description?.trim()) score += 1;
    if (entry.provider?.trim()) score += 1;
    if (entry.sourceUrl?.trim()) score += 1;
    if (entry.rowsHint?.trim() && entry.rowsHint !== 'Unknown') score += 1;
    if (entry.licenseHint?.trim() && entry.licenseHint !== 'See source page') score += 1;
    if (entry.providerDetail?.trim()) score += 0.5;
    if (entry.downloadUrl?.trim()) score += 0.5;
    if (entry.downloadHint?.trim()) score += 0.5;
    return Math.min(1, score / 7.5);
  }

  private knownSourceDownloadUrl(connector: CollectionSourceId, sourceUrl?: string): string | undefined {
    if (!sourceUrl?.trim()) {
      return undefined;
    }
    return sourceUrl;
  }

  private knownSourceDownloadMethod(connector: CollectionSourceId): 'source-page' | 'api' | 'cli' {
    switch (connector) {
      case 'openml':
        return 'api';
      case 'kaggle':
        return 'cli';
      default:
        return 'source-page';
    }
  }

  private knownSourceDownloadHint(connector: CollectionSourceId, sourceUrl?: string): string | undefined {
    const reference = this.knownSourceDownloadReference(connector, sourceUrl);
    switch (connector) {
      case 'huggingface':
        return reference
          ? `Open the Hugging Face dataset page for ${reference} and download files from the repo tree or hub API.`
          : 'Open the Hugging Face dataset page and download files from the repo tree or hub API.';
      case 'kaggle':
        return reference ? `Run: kaggle datasets download -d ${reference}` : 'Run Kaggle CLI download for the dataset reference.';
      case 'openml':
        return reference
          ? `Open the OpenML dataset page for ${reference} and use the API/data links.`
          : 'Open the OpenML dataset page and use the API/data links.';
      case 'uci':
        return reference
          ? `Open the UCI dataset page for ${reference} and use the data folder or download links.`
          : 'Open the UCI dataset page and use the data folder or download links.';
      default:
        return undefined;
    }
  }

  private knownSourceDownloadReference(connector: CollectionSourceId, sourceUrl?: string): string | undefined {
    if (!sourceUrl?.trim()) {
      return undefined;
    }
    try {
      const url = new URL(sourceUrl);
      const path = url.pathname.replace(/\/+$/, '');
      switch (connector) {
        case 'huggingface': {
          const match = path.match(/\/datasets\/(.+)$/);
          return match?.[1];
        }
        case 'kaggle': {
          const match = path.match(/\/datasets\/([^/]+\/[^/]+)$/);
          return match?.[1];
        }
        case 'openml': {
          const id = url.searchParams.get('id');
          if (id) {
            return id;
          }
          const match = path.match(/\/(?:d|dataset|search)\/?(\d+)/);
          return match?.[1];
        }
        case 'uci': {
          const match = path.match(/\/dataset\/([^/]+)$/);
          return match?.[1];
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private joinHints(primary?: string, extra?: string): string | undefined {
    return [primary?.trim(), extra?.trim()].filter(Boolean).join(' | ') || undefined;
  }
}
