import { Injectable } from '@nestjs/common';
import { domainCatalog } from '../common/catalog';
import type {
  DatasetAnalysisResponse,
  DatasetRecord,
  DomainRecommendationResponse,
  RecommendedDomain,
} from '../common/contracts';

type OpenAiRecommendationItem = {
  id: string;
  recommendationReason: string;
  keywords: string[];
  relevance: 'high' | 'medium' | 'low';
};

type OpenAiRecommendationPayload = {
  extractedKeywords: string[];
  descriptionSignals: string[];
  recommendedDomains: OpenAiRecommendationItem[];
  expandedKeywords: string[];
  generatedQueries: string[];
};

@Injectable()
export class OpenAiRecommendationService {
  private readonly maxConnectRetries = 2;
  private readonly provider = (process.env.LLM_PROVIDER ?? 'rule-based').trim().toLowerCase();
  private readonly apiKey =
    process.env.LLM_API_KEY?.trim() ?? process.env.OPENAI_API_KEY?.trim() ?? '';
  private readonly baseUrl = (
    process.env.LLM_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  private readonly model =
    process.env.LLM_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini';
  private readonly apiMode =
    (process.env.LLM_API_MODE?.trim().toLowerCase() ||
      (this.provider === 'openai' ? 'responses' : 'chat_completions')) as
      | 'responses'
      | 'chat_completions';
  private readonly timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS ?? 30000);

  isEnabled(): boolean {
    if (this.provider === 'openai') {
      return this.apiKey.length > 0;
    }

    return ['openai-compatible', 'vllm'].includes(this.provider) && this.baseUrl.length > 0 && this.model.length > 0;
  }

  async generateRecommendation(input: {
    dataset: DatasetRecord;
    analysis: DatasetAnalysisResponse;
    metadataColumns: string[];
    datasetSummary: DomainRecommendationResponse['datasetSummary'];
    deterministicFeatureColumns: string[];
  }): Promise<DomainRecommendationResponse | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const parsed =
        this.apiMode === 'chat_completions'
          ? await this.callChatCompletions(input, controller.signal)
          : await this.callResponsesApi(input, controller.signal);

      if (!parsed) {
        throw new Error('LLM response did not contain structured JSON output.');
      }

      const normalizedDomains = this.normalizeDomains(parsed.recommendedDomains);
      if (normalizedDomains.length === 0) {
        throw new Error('LLM returned no valid recommended domains.');
      }

      console.info(
        `[OpenAiRecommendationService] recommendation generated via ${this.provider} (${this.apiMode}, model=${this.model})`,
      );

      return {
        sessionId: input.dataset.sessionId,
        datasetId: input.dataset.id,
        datasetSummary: input.datasetSummary,
        evidenceSummary: {
          extractedKeywords: parsed.extractedKeywords.slice(0, 12),
          influentialFeatureColumns: input.deterministicFeatureColumns.slice(0, 6),
          influentialTargetColumns: input.dataset.targetColumns.slice(0, 4),
          descriptionSignals: parsed.descriptionSignals.slice(0, 6),
        },
        recommendedDomains: normalizedDomains,
        expandedKeywords: parsed.expandedKeywords.slice(0, 18),
        generatedQueries: parsed.generatedQueries.slice(0, 5),
      };
    } catch (error) {
      const message = this.describeError(error);
      console.warn(
        `[OpenAiRecommendationService] fallback to rule-based recommendation (${this.provider}/${this.apiMode}/${this.model}, baseUrl=${this.baseUrl}): ${message}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const parts = [`${error.name}: ${error.message}`];
    const withCode = error as Error & { code?: unknown; cause?: unknown };

    if (typeof withCode.code === 'string' && withCode.code.length > 0) {
      parts.push(`code=${withCode.code}`);
    }

    const cause = withCode.cause;
    if (cause instanceof Error) {
      parts.push(`cause=${cause.name}: ${cause.message}`);
      const causeWithCode = cause as Error & { code?: unknown };
      if (typeof causeWithCode.code === 'string' && causeWithCode.code.length > 0) {
        parts.push(`causeCode=${causeWithCode.code}`);
      }
    } else if (cause) {
      try {
        parts.push(`cause=${JSON.stringify(cause)}`);
      } catch {
        parts.push(`cause=${String(cause)}`);
      }
    }

    return parts.join(' | ');
  }

  private buildSystemPrompt(): string {
    return [
      'You are selecting relevant problem domains for an uploaded tabular dataset.',
      'Return JSON only.',
      'Start with { and end with }.',
      'Do not include markdown fences.',
      'Do not include analysis, preamble, or explanation outside JSON.',
      'Use only the provided domain catalog IDs.',
      'Do not invent new domains.',
      'Favor practical search utility for downstream discovery over broad speculation.',
      'When the evidence is weak, keep relevance low instead of overstating confidence.',
    ].join(' ');
  }

  private buildUserPrompt(input: {
    dataset: DatasetRecord;
    analysis: DatasetAnalysisResponse;
    metadataColumns: string[];
    deterministicFeatureColumns: string[];
  }): string {
    const domainList = domainCatalog
      .map(
        (domain) =>
          `- ${domain.id}: ${domain.title} | ${domain.shortDescription} | keywords=${domain.keywords.join(', ')}`,
      )
      .join('\n');

    return [
      'Select up to 5 domains from the catalog and produce search-oriented recommendation output.',
      'Dataset summary:',
      `fileName=${input.dataset.fileName}`,
      `taskType=${input.dataset.taskType}`,
      `rowCount=${input.dataset.rowCount}`,
      `colCount=${input.dataset.colCount}`,
      `columns=${input.dataset.columns.join(', ')}`,
      `targetColumns=${input.dataset.targetColumns.join(', ')}`,
      `metadataColumns=${input.metadataColumns.join(', ') || '(none)'}`,
      `featureColumns=${input.deterministicFeatureColumns.join(', ') || '(none)'}`,
      `description=${input.dataset.description || '(empty)'}`,
      `missingRates=${input.analysis.missingStats
        .map((item) => `${item.column}:${item.missingRate.toFixed(3)}`)
        .join(', ')}`,
      `imbalanceSummary=${input.analysis.imbalanceSummary
        .map((item) => {
          const stat = item.stat;
          return stat
            ? `${item.col}:distinct=${stat.distinctCount},minority=${stat.minorityRatio.toFixed(3)},ratio=${stat.imbalanceRatio ?? 'null'}`
            : `${item.col}:skipped`;
        })
        .join(' | ') || '(none)'}`,
      `numericSummary=${input.analysis.numericSummary
        .map((item) => {
          const stat = item.stat;
          return stat
            ? `${item.col}:min=${stat.min},max=${stat.max},mean=${stat.mean},std=${stat.std}`
            : `${item.col}:none`;
        })
        .join(' | ') || '(none)'}`,
      'Domain catalog:',
      domainList,
      'Return a JSON object only with keys: extractedKeywords, descriptionSignals, recommendedDomains, expandedKeywords, generatedQueries.',
      'Each recommendedDomains item must contain: id, recommendationReason, keywords, relevance.',
      'Example shape: {"extractedKeywords":["k1"],"descriptionSignals":["s1"],"recommendedDomains":[{"id":"dom-medical","recommendationReason":"reason","keywords":["k1"],"relevance":"low"}],"expandedKeywords":["k1"],"generatedQueries":["query"]}',
    ].join('\n');
  }

  private async callResponsesApi(
    input: {
      dataset: DatasetRecord;
      analysis: DatasetAnalysisResponse;
      metadataColumns: string[];
      datasetSummary: DomainRecommendationResponse['datasetSummary'];
      deterministicFeatureColumns: string[];
    },
    signal: AbortSignal,
  ): Promise<OpenAiRecommendationPayload | null> {
    const response = await this.fetchWithRetry(this.buildResponsesUrl(), {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: this.buildSystemPrompt(),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: this.buildUserPrompt(input),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'domain_recommendation',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'extractedKeywords',
                'descriptionSignals',
                'recommendedDomains',
                'expandedKeywords',
                'generatedQueries',
              ],
              properties: {
                extractedKeywords: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 12,
                },
                descriptionSignals: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 6,
                },
                recommendedDomains: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'recommendationReason', 'keywords', 'relevance'],
                    properties: {
                      id: {
                        type: 'string',
                        enum: domainCatalog.map((domain) => domain.id),
                      },
                      recommendationReason: {
                        type: 'string',
                      },
                      keywords: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: 6,
                      },
                      relevance: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                      },
                    },
                  },
                  minItems: 1,
                  maxItems: 5,
                },
                expandedKeywords: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 18,
                },
                generatedQueries: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 5,
                },
              },
            },
          },
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`LLM responses request failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.extractJsonPayload(payload);
  }

  private async callChatCompletions(
    input: {
      dataset: DatasetRecord;
      analysis: DatasetAnalysisResponse;
      metadataColumns: string[];
      datasetSummary: DomainRecommendationResponse['datasetSummary'];
      deterministicFeatureColumns: string[];
    },
    signal: AbortSignal,
  ): Promise<OpenAiRecommendationPayload | null> {
    const response = await this.fetchWithRetry(this.buildChatCompletionsUrl(), {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: this.buildSystemPrompt(),
          },
          {
            role: 'user',
            content: this.buildUserPrompt(input),
          },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 900,
        top_p: 1,
        reasoning_effort: 'low',
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`LLM chat completion request failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content ?? '';
    const extracted = this.extractJsonBlock(content);
    if (!extracted) {
      throw new Error('No JSON block found in chat completion response.');
    }

    return JSON.parse(extracted) as OpenAiRecommendationPayload;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxConnectRetries + 1; attempt += 1) {
      try {
        return await fetch(url, init);
      } catch (error) {
        lastError = error;
        if (!this.isRetryableConnectError(error) || attempt > this.maxConnectRetries) {
          throw error;
        }

        console.warn(
          `[OpenAiRecommendationService] retrying LLM request after connect failure (${attempt}/${this.maxConnectRetries}, baseUrl=${this.baseUrl})`,
        );

        await this.delay(350 * attempt, init.signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private isRetryableConnectError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const withCause = error as Error & { cause?: unknown };
    const cause = withCause.cause;
    if (!(cause instanceof Error)) {
      return false;
    }

    const causeWithCode = cause as Error & { code?: unknown };
    return causeWithCode.code === 'UND_ERR_CONNECT_TIMEOUT';
  }

  private async delay(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      throw new Error('LLM request was aborted before retry.');
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        cleanup();
        reject(new Error('LLM request was aborted before retry.'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private buildHeaders(requireAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (requireAuth) {
      throw new Error('OPENAI_API_KEY or LLM_API_KEY is required for this provider.');
    }

    return headers;
  }

  private buildResponsesUrl(): string {
    const base = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}/responses`;
  }

  private buildChatCompletionsUrl(): string {
    const base = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}/chat/completions`;
  }

  private extractJsonPayload(payload: Record<string, unknown>): OpenAiRecommendationPayload | null {
    const outputParsed = payload.output_parsed;
    if (outputParsed && typeof outputParsed === 'object') {
      return outputParsed as OpenAiRecommendationPayload;
    }

    const outputText = this.extractOutputText(payload);
    if (!outputText) {
      return null;
    }

    return JSON.parse(outputText) as OpenAiRecommendationPayload;
  }

  private extractJsonBlock(text: string): string | null {
    const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1);
    }

    return null;
  }

  private extractOutputText(payload: Record<string, unknown>): string | null {
    const direct = payload.output_text;
    if (typeof direct === 'string' && direct.trim()) {
      return direct;
    }

    const output = payload.output;
    if (!Array.isArray(output)) {
      return null;
    }

    for (const message of output) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          return text;
        }
      }
    }

    return null;
  }

  private normalizeDomains(items: OpenAiRecommendationItem[]): RecommendedDomain[] {
    const seen = new Set<string>();
    const result: RecommendedDomain[] = [];

    for (const item of items) {
      if (seen.has(item.id)) {
        continue;
      }
      const match = domainCatalog.find((domain) => domain.id === item.id);
      if (!match) {
        continue;
      }

      seen.add(item.id);
      result.push({
        id: match.id,
        name: match.title,
        shortDescription: match.shortDescription,
        recommendationReason: item.recommendationReason,
        keywords: item.keywords.slice(0, 6),
        relevance: item.relevance,
      });
    }

    return result.slice(0, 5);
  }
}
