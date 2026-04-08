import { Injectable } from '@nestjs/common';
import type {
  CollectionGenericHtmlLlmPlan,
  CollectionGenericPageType,
} from '../common/contracts';
import { CollectionLlmClientService } from './collection-llm-client.service';
import { extractJsonBlock, previewLlmText } from './collection-llm.utils';

type RawGenericHtmlPlan = {
  pageType?: string;
  confidence?: number | string;
  title?: string;
  provider?: string;
  summary?: string;
  licenseHint?: string;
  selectedDownloadCandidates?: string[] | string;
  selectedFollowLinks?: string[] | string;
  reason?: string;
};

type ParsedGenericHtmlPlan = {
  rawOutput: string;
  plan: CollectionGenericHtmlLlmPlan;
};

const pageTypes: CollectionGenericPageType[] = [
  'dataset-landing',
  'direct-file',
  'knowledge-page',
  'generic-page',
  'unsupported',
];

@Injectable()
export class CollectionGenericHtmlLlmService {
  private readonly enabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECTION_GENERIC_HTML_LLM_ENABLED ?? 'false').trim().toLowerCase(),
  );
  private readonly strictFailure = ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECTION_GENERIC_HTML_LLM_STRICT ?? 'false').trim().toLowerCase(),
  );

  constructor(private readonly llmClient: CollectionLlmClientService) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  isStrictFailure(): boolean {
    return this.strictFailure;
  }

  async planDocument(input: {
    pageUrl: string;
    detectedHost?: string;
    currentTitle?: string;
    currentDescription?: string;
    extractedText: string;
    linkCandidates: string[];
    matchedQueries: string[];
    matchedTerms: string[];
  }): Promise<ParsedGenericHtmlPlan | null> {
    if (!this.enabled) {
      return null;
    }
    if (!this.llmClient.isConfigured()) {
      const message = 'Collection generic HTML LLM is enabled but the shared collection LLM client is not configured.';
      if (this.strictFailure) {
        throw new Error(message);
      }
      console.warn(`[CollectionGenericHtmlLlmService] ${message}`);
      return null;
    }

    try {
      const rawOutput = await this.llmClient.requestJson({
        schemaName: 'collection_generic_html_plan',
        schema: this.schema(),
        systemPrompt: this.systemPrompt(),
        userPrompt: this.userPrompt(input),
      });
      const parsed = this.parsePlan(rawOutput, input);
      if (!parsed) {
        console.warn(
          `[CollectionGenericHtmlLlmService] generic HTML planner returned unparseable output: ${previewLlmText(rawOutput)}`,
        );
        return null;
      }
      return {
        rawOutput,
        plan: parsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.strictFailure) {
        throw new Error(`Collection generic HTML LLM failed: ${message}`);
      }
      console.warn(`[CollectionGenericHtmlLlmService] generic HTML planner soft-failed: ${message}`);
      return null;
    }
  }

  private systemPrompt(): string {
    return [
      'You assist only the collection module generic HTML layer.',
      'Return only one JSON object.',
      'The first character must be "{" and the last character must be "}".',
      'Do not include analysis, markdown, code fences, or explanations.',
      'Do not invent URLs, datasets, providers, or download links.',
      'You may select only from the provided linkCandidates or the current page URL.',
      'Prefer direct file links such as csv, parquet, jsonl, zip, arff, or tsv when they are present.',
      'Do not select login, sign-up, manifest, privacy, or unrelated links.',
      'If this is not a usable dataset page, return an empty selectedDownloadCandidates array.',
    ].join(' ');
  }

  private userPrompt(input: Parameters<CollectionGenericHtmlLlmService['planDocument']>[0]): string {
    return [
      `pageUrl=${input.pageUrl}`,
      `detectedHost=${input.detectedHost ?? '(unknown)'}`,
      `currentTitle=${input.currentTitle ?? '(none)'}`,
      `currentDescription=${input.currentDescription ?? '(none)'}`,
      `matchedQueries=${input.matchedQueries.join(' | ') || '(none)'}`,
      `matchedTerms=${input.matchedTerms.join(', ') || '(none)'}`,
      `linkCandidates=${input.linkCandidates.join(' | ') || '(none)'}`,
      `extractedTextPreview=${input.extractedText.slice(0, 1600) || '(none)'}`,
      'Return exactly one JSON object with keys: pageType, confidence, title, provider, summary, licenseHint, selectedDownloadCandidates, selectedFollowLinks, reason.',
      `allowedPageTypes=${pageTypes.join(', ')}`,
      'selectedDownloadCandidates must contain only URLs from linkCandidates or the current pageUrl.',
      'selectedFollowLinks must contain only URLs from linkCandidates or the current pageUrl.',
      'Keep summary short and factual.',
    ].join('\n');
  }

  private schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'pageType',
        'confidence',
        'title',
        'provider',
        'summary',
        'licenseHint',
        'selectedDownloadCandidates',
        'selectedFollowLinks',
        'reason',
      ],
      properties: {
        pageType: { type: 'string', enum: pageTypes },
        confidence: { type: 'number' },
        title: { type: 'string' },
        provider: { type: 'string' },
        summary: { type: 'string' },
        licenseHint: { type: 'string' },
        selectedDownloadCandidates: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
        },
        selectedFollowLinks: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
        },
        reason: { type: 'string' },
      },
    };
  }

  private parsePlan(
    text: string,
    input: Parameters<CollectionGenericHtmlLlmService['planDocument']>[0],
  ): CollectionGenericHtmlLlmPlan | null {
    const jsonBlock = extractJsonBlock(text);
    if (!jsonBlock) {
      return null;
    }
    try {
      const raw = JSON.parse(jsonBlock) as RawGenericHtmlPlan;
      return this.normalizePlan(raw, input);
    } catch {
      return null;
    }
  }

  private normalizePlan(
    raw: RawGenericHtmlPlan,
    input: Parameters<CollectionGenericHtmlLlmService['planDocument']>[0],
  ): CollectionGenericHtmlLlmPlan | null {
    const allowedUrls = new Set([input.pageUrl, ...input.linkCandidates].filter(Boolean));
    const pageType = this.normalizePageType(raw.pageType);
    if (!pageType) {
      return null;
    }

    const selectedDownloadCandidates = this.normalizeAllowedUrls(raw.selectedDownloadCandidates, allowedUrls);
    const selectedFollowLinks = this.normalizeAllowedUrls(raw.selectedFollowLinks, allowedUrls);
    const confidence = this.normalizeConfidence(raw.confidence);
    const reason = String(raw.reason ?? '').trim();

    if (!reason) {
      return null;
    }

    return {
      pageType,
      confidence,
      title: this.normalizeOptionalText(raw.title, 180),
      provider: this.normalizeOptionalText(raw.provider, 120),
      summary: this.normalizeOptionalText(raw.summary, 320),
      licenseHint: this.normalizeOptionalText(raw.licenseHint, 120),
      selectedDownloadCandidates,
      selectedFollowLinks,
      reason,
    };
  }

  private normalizePageType(value: unknown): CollectionGenericPageType | null {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-');
    return pageTypes.find((candidate) => candidate === normalized) ?? null;
  }

  private normalizeAllowedUrls(value: unknown, allowedUrls: Set<string>): string[] {
    const items = Array.isArray(value)
      ? value.map((entry) => String(entry).trim())
      : typeof value === 'string'
        ? value
            .split(/\n|,/)
            .map((entry) => entry.trim())
        : [];
    return [...new Set(items.filter((entry) => entry && allowedUrls.has(entry)))].slice(0, 4);
  }

  private normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return undefined;
    }
    return normalized.slice(0, maxLength);
  }

  private normalizeConfidence(value: unknown): number {
    const raw = typeof value === 'string' ? Number(value) : Number(value ?? 0);
    if (!Number.isFinite(raw)) {
      return 0;
    }
    return Math.max(0, Math.min(1, raw));
  }
}
