import { Injectable } from '@nestjs/common';
import type {
  CollectionSourceClassification,
  CollectionSourceConfidence,
  CollectionSourceId,
} from '../common/contracts';
import {
  buildDatasetEntry,
  buildKnowledgeEntry,
} from './connectors/connector.utils';
import {
  detectKnownSource,
  genericFetchLimit,
} from './collection-layer.config';
import { CollectionHtmlExtractionService } from './collection-html-extraction.service';
import { CollectionBrowserFallbackService } from './collection-browser-fallback.service';
import { CollectionGenericHtmlLlmService } from './collection-generic-html-llm.service';
import { previewLlmText } from './collection-llm.utils';
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

@Injectable()
export class CollectionWebRoutingService {
  constructor(
    private readonly htmlExtractionService: CollectionHtmlExtractionService,
    private readonly browserFallbackService: CollectionBrowserFallbackService,
    private readonly genericHtmlLlmService: CollectionGenericHtmlLlmService,
  ) {}

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
          const fetched = await this.fetchUnknownDocumentWithFallback(hit.id, url);
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
              extractionMethod: fetched.document.extractionMethod,
              extractionReliability: fetched.document.extractionMethod === 'browser' ? 0.52 : 0.58,
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
            this.htmlExtractionService.isDirectFileUrl(url) || hit.directDownloadAvailable,
        };

        if (layer === 'generic' && sourceClassification === 'known' && routedConnector) {
          const knownDownloadUrl =
            this.knownSourceDownloadUrl(routedConnector, updatedHit.entry.sourceUrl) ||
            this.knownSourceDownloadUrl(routedConnector, updatedHit.entry.downloadUrl);
          const knownDownloadReference =
            this.knownSourceDownloadReference(routedConnector, updatedHit.entry.sourceUrl) ||
            this.knownSourceDownloadReference(routedConnector, updatedHit.entry.downloadUrl);
          const knownDownloadMethod = this.knownSourceDownloadMethod(routedConnector);
          const knownDownloadHint = this.knownSourceDownloadHint(
            routedConnector,
            updatedHit.entry.sourceUrl || updatedHit.entry.downloadUrl,
          );

          updatedHit = {
            ...updatedHit,
            entry: buildDatasetEntry({
              ...updatedHit.entry,
              provider: this.providerLabelForConnector(routedConnector),
              downloadUrl:
                knownDownloadUrl ||
                updatedHit.entry.downloadUrl ||
                updatedHit.entry.sourceUrl,
              downloadMethod: knownDownloadMethod,
              downloadHint: knownDownloadHint || updatedHit.entry.downloadHint,
              downloadReference:
                knownDownloadReference ||
                updatedHit.entry.downloadReference ||
                updatedHit.entry.downloadUrl ||
                updatedHit.entry.sourceUrl,
              retrievalHint: this.joinHints(
                updatedHit.entry.retrievalHint,
                `Generic result rerouted to ${routedConnector}`,
              ),
            }),
          };
        }

        if (layer === 'generic' && sourceClassification === 'unknown' && url && fetchBudget > 0) {
          fetchBudget -= 1;
          const fetched = await this.fetchUnknownDocumentWithFallback(hit.id, url);
          if (fetched) {
            const planned = await this.genericHtmlLlmService.planDocument({
              pageUrl: url,
              detectedHost,
              currentTitle: updatedHit.entry.name,
              currentDescription: updatedHit.entry.description,
              extractedText: fetched.document.extractedText,
              linkCandidates: fetched.metadata.linkCandidates,
              matchedQueries: updatedHit.matchedQueries,
              matchedTerms: updatedHit.matchedTerms,
            });
            const plannerDownloadUrl = planned?.plan.selectedDownloadCandidates[0];
            const plannerDirectDownloadUrl =
              plannerDownloadUrl && this.htmlExtractionService.isDirectFileUrl(plannerDownloadUrl)
                ? plannerDownloadUrl
                : undefined;
            const plannerFollowUrl = planned?.plan.selectedFollowLinks[0];
            const plannerDescription = planned?.plan.summary;
            const plannerProvider = planned?.plan.provider;
            const plannerTitle = planned?.plan.title;
            const plannerLicense = planned?.plan.licenseHint;
            const plannerHint = planned
              ? `Generic HTML LLM plan from ${detectedHost || 'web'}: ${planned.plan.reason}`
              : undefined;

            fetched.document.llmPlannerUsed = planned != null;
            fetched.document.llmPlanRawPreview = planned
              ? previewLlmText(planned.rawOutput, 320)
              : null;
            fetched.document.llmPlan = planned?.plan ?? null;
            fetchedDocuments.push(fetched.document);

            updatedHit = {
              ...updatedHit,
              entry: buildDatasetEntry({
                ...updatedHit.entry,
                name:
                  plannerTitle ||
                  fetched.metadata.title ||
                  updatedHit.entry.name,
                provider:
                  plannerProvider ||
                  updatedHit.entry.provider ||
                  detectedHost ||
                  'web',
                description:
                  plannerDescription ||
                  fetched.metadata.description ||
                  updatedHit.entry.description,
                licenseHint:
                  plannerLicense ||
                  fetched.metadata.licenseHint ||
                  updatedHit.entry.licenseHint,
                downloadUrl:
                  plannerDirectDownloadUrl ||
                  plannerDownloadUrl ||
                  fetched.metadata.downloadUrl ||
                  plannerFollowUrl ||
                  updatedHit.entry.downloadUrl ||
                  updatedHit.entry.sourceUrl,
                downloadMethod:
                  plannerDirectDownloadUrl || fetched.metadata.downloadUrl
                    ? 'direct'
                    : updatedHit.entry.downloadMethod || 'source-page',
                downloadHint:
                  plannerDirectDownloadUrl
                    ? 'Direct file URL selected by collection generic HTML LLM plan.'
                    : fetched.metadata.downloadUrl
                      ? 'Direct file URL discovered during generic HTML extraction.'
                      : updatedHit.entry.downloadHint || 'Open the source page and inspect dataset or download links.',
                downloadReference:
                  plannerDirectDownloadUrl ||
                  plannerDownloadUrl ||
                  plannerFollowUrl ||
                  fetched.metadata.downloadUrl ||
                  updatedHit.entry.downloadReference ||
                  updatedHit.entry.sourceUrl,
                retrievalHint: this.joinHints(
                  this.joinHints(
                    updatedHit.entry.retrievalHint,
                    `Generic HTML extraction from ${detectedHost || 'web'}`,
                  ),
                  plannerHint,
                ),
                tags: [
                  ...updatedHit.entry.tags,
                  ...(fetched.metadata.linkCandidates ?? []),
                ],
              }),
              text: `${plannerTitle || fetched.metadata.title || updatedHit.title} ${
                plannerDescription || fetched.metadata.description || updatedHit.text
              }`,
              extractionMethod: fetched.document.extractionMethod,
              extractionReliability: this.datasetExtractionReliability(
                fetched.document.extractionMethod,
                planned != null,
              ),
              directDownloadAvailable:
                Boolean(plannerDirectDownloadUrl) ||
                fetched.metadata.directDownloadAvailable ||
                updatedHit.directDownloadAvailable,
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

  private async fetchUnknownDocumentWithFallback(sourceHitId: string, url: string) {
    const htmlFetched = await this.htmlExtractionService.fetchDocument(sourceHitId, url, 'html');
    if (!this.browserFallbackService.isEnabled()) {
      return htmlFetched;
    }
    if (!htmlFetched) {
      return this.browserFallbackService.fetchDocument(sourceHitId, url);
    }
    if (!this.shouldUseBrowserFallback(htmlFetched)) {
      return htmlFetched;
    }
    const browserFetched = await this.browserFallbackService.fetchDocument(sourceHitId, url);
    return browserFetched ?? htmlFetched;
  }

  private shouldUseBrowserFallback(fetched: Awaited<ReturnType<CollectionHtmlExtractionService['fetchDocument']>>): boolean {
    if (!fetched) {
      return true;
    }
    const metadata = fetched.metadata;
    const weakMetadata = !metadata.title && !metadata.description && metadata.linkCandidates.length === 0;
    const lowTextSignal = fetched.document.extractedText.length < 160;
    const noDownloadHints = !metadata.directDownloadAvailable && !metadata.downloadUrl;
    return weakMetadata || (lowTextSignal && noDownloadHints);
  }

  private datasetExtractionReliability(extractionMethod: FetchedDocument['extractionMethod'], llmPlanned: boolean): number {
    if (extractionMethod === 'browser') {
      return llmPlanned ? 0.6 : 0.5;
    }
    return llmPlanned ? 0.64 : 0.56;
  }

  private hostFromUrl(url?: string): string | undefined {
    return this.htmlExtractionService.hostFromUrl(url);
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
