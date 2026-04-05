import { Injectable } from '@nestjs/common';
import { domainCatalog, modalityCatalog, taskCatalog } from '../common/catalog';
import { tokenize, uniqueKeepOrder } from '../common/text';
import type {
  DatasetAnalysisResponse,
  DatasetRecord,
  DomainRecommendationResponse,
  ModalitySignal,
  RecommendedDomain,
  TaskSignal,
} from '../common/contracts';

type OpenAiRecommendationItem = {
  id?: string;
  name?: string;
  recommendationReason: string;
  keywords: string[];
  relevance: 'high' | 'medium' | 'low';
};

type OpenAiRecommendationPayload = {
  extractedKeywords: string[];
  descriptionSignals: string[];
  primaryDomainId?: string;
  taskSignals?: string[];
  modalitySignals?: string[];
  recommendedDomains: OpenAiRecommendationItem[];
  expandedKeywords: string[];
  generatedQueries: string[];
};

type ParsedLlmRecommendation = {
  payload: OpenAiRecommendationPayload;
  rawOutput: string;
};

type DomainMappingResult = {
  domains: RecommendedDomain[];
  mapped: Array<{ input: string; domainId: string; method: string }>;
  unmapped: string[];
};

type SignalMappingResult<T extends string> = {
  signals: T[];
  mapped: Array<{ input: string; id: T; method: string }>;
  unmapped: string[];
};

@Injectable()
export class OpenAiRecommendationService {
  private readonly maxConnectRetries = 2;
  private readonly provider = (process.env.LLM_PROVIDER ?? 'rule-based').trim().toLowerCase();
  private readonly allowRuleBasedFallback = ['1', 'true', 'yes', 'on'].includes(
    (process.env.LLM_ALLOW_RULE_BASED_FALLBACK ?? '').trim().toLowerCase(),
  );
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

      const mappingResult = this.normalizeDomains(parsed.payload.recommendedDomains);
      const taskMapping = this.normalizeTaskSignals(parsed.payload.taskSignals ?? [], input.analysis.taskSignals ?? []);
      const modalityMapping = this.normalizeModalitySignals(
        parsed.payload.modalitySignals ?? [],
        input.analysis.modalitySignals ?? [],
      );
      const primaryDomainId = this.resolvePrimaryDomainId(
        parsed.payload.primaryDomainId,
        mappingResult.domains,
      );
      console.info(
        `[OpenAiRecommendationService] raw output ${JSON.stringify({
          datasetId: input.dataset.id,
          rawOutput: parsed.rawOutput,
          primaryDomainId,
          mapped: mappingResult.mapped,
          unmapped: mappingResult.unmapped,
          mappedTaskSignals: taskMapping.mapped,
          unmappedTaskSignals: taskMapping.unmapped,
          mappedModalitySignals: modalityMapping.mapped,
          unmappedModalitySignals: modalityMapping.unmapped,
        })}`,
      );

      if (mappingResult.domains.length === 0) {
        throw new Error(
          `LLM returned no valid recommended domains. mappingFailures=${mappingResult.unmapped.join(', ') || '(empty)'}`,
        );
      }

      console.info(
        `[OpenAiRecommendationService] recommendation generated via ${this.provider} (${this.apiMode}, model=${this.model})`,
      );

      return {
        sessionId: input.dataset.sessionId,
        datasetId: input.dataset.id,
        datasetSummary: input.datasetSummary,
        evidenceSummary: {
          extractedKeywords: parsed.payload.extractedKeywords.slice(0, 12),
          influentialFeatureColumns: input.deterministicFeatureColumns.slice(0, 6),
          influentialTargetColumns: input.dataset.targetColumns.slice(0, 4),
          descriptionSignals: parsed.payload.descriptionSignals.slice(0, 6),
        },
        primaryDomainId,
        taskSignals: taskMapping.signals,
        modalitySignals: modalityMapping.signals,
        recommendedDomains: mappingResult.domains,
        expandedKeywords: parsed.payload.expandedKeywords.slice(0, 18),
        generatedQueries: parsed.payload.generatedQueries.slice(0, 5),
      };
    } catch (error) {
      const message = this.describeError(error);
      if (this.allowRuleBasedFallback) {
        console.warn(
          `[OpenAiRecommendationService] fallback to rule-based recommendation (${this.provider}/${this.apiMode}/${this.model}, baseUrl=${this.baseUrl}): ${message}`,
        );
        return null;
      }

      console.error(
        `[OpenAiRecommendationService] remote recommendation failed (${this.provider}/${this.apiMode}/${this.model}, baseUrl=${this.baseUrl}): ${message}`,
      );
      throw new Error(
        `Remote LLM recommendation failed and fallback is disabled. ${message}`,
      );
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
      'Choose only from the provided domain catalog.',
      'Choose task signals only from the provided task catalog.',
      'Choose modality signals only from the provided modality catalog.',
      'Prefer the provided domain IDs, but if needed you may also repeat the catalog title in the name field.',
      'Do not invent new domains outside the catalog.',
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
          `- ${domain.id}: ${domain.title} | ${domain.shortDescription} | aliases=${(domain.aliases ?? []).join(', ') || '(none)'} | keywords=${domain.keywords.join(', ')}`,
      )
      .join('\n');
    const taskList = taskCatalog
      .map(
        (task) =>
          `- ${task.id}: ${task.title} | aliases=${(task.aliases ?? []).join(', ') || '(none)'} | signals=${[
            ...(task.strongSignals ?? []),
            ...(task.supportSignals ?? []),
          ].join(', ')}`,
      )
      .join('\n');
    const modalityList = modalityCatalog
      .map(
        (modality) =>
          `- ${modality.id}: ${modality.title} | aliases=${(modality.aliases ?? []).join(', ') || '(none)'} | keywords=${(modality.keywords ?? []).join(', ')}`,
      )
      .join('\n');

    return [
      'Select 1 to 4 domains from the catalog and produce search-oriented recommendation output.',
      'Dataset summary:',
      `fileName=${input.dataset.fileName}`,
      `taskType=${input.dataset.taskType}`,
      `rowCount=${input.dataset.rowCount}`,
      `colCount=${input.dataset.colCount}`,
      `columns=${input.dataset.columns.join(', ')}`,
      `targetColumns=${input.dataset.targetColumns.join(', ')}`,
      `metadataColumns=${input.metadataColumns.join(', ') || '(none)'}`,
      `featureColumns=${input.deterministicFeatureColumns.join(', ') || '(none)'}`,
      `taskSignals=${(input.analysis.taskSignals ?? []).join(', ') || '(none)'}`,
      `modalitySignals=${(input.analysis.modalitySignals ?? []).join(', ') || '(none)'}`,
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
      'Task catalog:',
      taskList,
      'Modality catalog:',
      modalityList,
      'Return a JSON object only with keys: extractedKeywords, descriptionSignals, primaryDomainId, taskSignals, modalitySignals, recommendedDomains, expandedKeywords, generatedQueries.',
      'Each recommendedDomains item must contain: id, name, recommendationReason, keywords, relevance.',
      'primaryDomainId must be one of the provided domain IDs.',
      'taskSignals must be selected only from the provided task IDs.',
      'modalitySignals must be selected only from the provided modality IDs.',
      'Use the catalog IDs when possible. If you use a natural-language label, put it in name and still try to keep id close to the catalog.',
      'Example shape: {"extractedKeywords":["k1"],"descriptionSignals":["s1"],"primaryDomainId":"dom-nlp","taskSignals":["classification"],"modalitySignals":["text","document"],"recommendedDomains":[{"id":"dom-nlp","name":"Natural language processing dataset for text understanding tasks","recommendationReason":"reason","keywords":["k1"],"relevance":"low"}],"expandedKeywords":["k1"],"generatedQueries":["query"]}',
    ].join('\n');
  }

  private buildStructuredSchema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'extractedKeywords',
        'descriptionSignals',
        'primaryDomainId',
        'taskSignals',
        'modalitySignals',
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
        primaryDomainId: {
          type: 'string',
        },
        taskSignals: {
          type: 'array',
          items: {
            type: 'string',
            enum: taskCatalog.map((task) => task.id),
          },
          minItems: 1,
          maxItems: 3,
        },
        modalitySignals: {
          type: 'array',
          items: {
            type: 'string',
            enum: modalityCatalog.map((modality) => modality.id),
          },
          minItems: 1,
          maxItems: 3,
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
              },
              name: {
                type: 'string',
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
    };
  }

  private async repairStructuredPayload(
    rawContent: string,
    signal: AbortSignal,
  ): Promise<OpenAiRecommendationPayload | null> {
    const schema = this.buildStructuredSchema();
    const response = await this.fetchWithRetry(this.buildChatCompletionsUrl(), {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'Convert the previous draft into valid JSON only. Return one JSON object that matches the provided schema exactly. Do not include analysis or markdown.',
          },
          {
            role: 'user',
            content: [
              'Previous draft:',
              rawContent,
              'Return valid JSON only with keys: extractedKeywords, descriptionSignals, primaryDomainId, taskSignals, modalitySignals, recommendedDomains, expandedKeywords, generatedQueries.',
            ].join('\n'),
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: 900,
        top_p: 1,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'domain_recommendation',
            strict: true,
            schema,
          },
        },
        extra_body: {
          guided_json: schema,
        },
      }),
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    return this.parseStructuredPayload(content);
  }

  private salvageStructuredPayload(
    rawContent: string,
    input: {
      dataset: DatasetRecord;
      analysis: DatasetAnalysisResponse;
      metadataColumns: string[];
      datasetSummary: DomainRecommendationResponse['datasetSummary'];
      deterministicFeatureColumns: string[];
    },
  ): OpenAiRecommendationPayload | null {
    const mentionedDomainIds = uniqueKeepOrder(
      (rawContent.match(/dom-[a-z0-9-]+/gi) ?? []).map((value) => value.toLowerCase()),
    );
    const rawReason = rawContent.replace(/\s+/g, ' ').trim();
    const resolvedDomains = uniqueKeepOrder([
      ...mentionedDomainIds
        .map((value) => this.resolveDomainId([value])?.domainId ?? null)
        .filter((value): value is string => value != null),
      this.resolveDomainId([rawContent])?.domainId ?? '',
    ]).filter(Boolean);

    if (resolvedDomains.length === 0) {
      return null;
    }

    const taskSignals = this.extractMentionedSignals<TaskSignal>(
      rawContent,
      taskCatalog.map((task) => ({ id: task.id, labels: [task.id, task.title, ...(task.aliases ?? [])] })),
      input.analysis.taskSignals ?? [],
    );
    const modalitySignals = this.extractMentionedSignals<ModalitySignal>(
      rawContent,
      modalityCatalog.map((modality) => ({
        id: modality.id,
        labels: [modality.id, modality.title, ...(modality.aliases ?? [])],
      })),
      input.analysis.modalitySignals ?? [],
    );
    const labelHints = uniqueKeepOrder(
      input.analysis.imbalanceSummary.flatMap((item) => item.stat?.valueCounts.map((value) => value.value) ?? []),
    );
    const extractedKeywords = uniqueKeepOrder([
      ...input.deterministicFeatureColumns.slice(0, 6),
      ...input.dataset.targetColumns,
      ...labelHints,
      ...taskSignals,
      ...modalitySignals,
    ]).slice(0, 12);
    const descriptionSignals = uniqueKeepOrder([
      input.dataset.description,
      `task signals: ${taskSignals.join(', ')}`,
      `modality signals: ${modalitySignals.join(', ')}`,
      'structured response salvaged from free-form LLM output',
    ])
      .filter(Boolean)
      .slice(0, 6);
    const recommendedDomains: OpenAiRecommendationItem[] = [];
    for (const domainId of resolvedDomains.slice(0, 4)) {
      const match = domainCatalog.find((domain) => domain.id === domainId);
      if (!match) {
        continue;
      }
      recommendedDomains.push({
        id: match.id,
        name: match.title,
        recommendationReason: rawReason.slice(0, 320),
        keywords: match.keywords.slice(0, 6),
        relevance: 'medium',
      });
    }
    const generatedQueries = uniqueKeepOrder(
      recommendedDomains.flatMap((domain) => {
        if (!domain.id) {
          return [];
        }
        const match = domainCatalog.find((entry) => entry.id === domain.id);
        return match?.querySeeds ?? [];
      }),
    ).slice(0, 5);

    return {
      extractedKeywords,
      descriptionSignals,
      primaryDomainId: resolvedDomains[0],
      taskSignals,
      modalitySignals,
      recommendedDomains,
      expandedKeywords: uniqueKeepOrder([...extractedKeywords, ...generatedQueries]).slice(0, 18),
      generatedQueries,
    };
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
  ): Promise<ParsedLlmRecommendation | null> {
    const schema = this.buildStructuredSchema();
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
            schema,
          },
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`LLM responses request failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawOutput = this.extractOutputText(payload) ?? JSON.stringify(payload);
    const parsed = this.extractJsonPayload(payload);
    return parsed ? { payload: parsed, rawOutput } : null;
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
  ): Promise<ParsedLlmRecommendation | null> {
    const schema = this.buildStructuredSchema();
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
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'domain_recommendation',
            strict: true,
            schema,
          },
        },
        extra_body: {
          guided_json: schema,
        },
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
    const parsed =
      this.parseStructuredPayload(content) ??
      (await this.repairStructuredPayload(content, signal)) ??
      this.salvageStructuredPayload(content, input);
    if (!parsed) {
      const preview = content.replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`No JSON block found in chat completion response. raw=${preview || '(empty)'}`);
    }

    return {
      payload: parsed,
      rawOutput: content,
    };
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

    return this.parseStructuredPayload(outputText);
  }

  private extractJsonBlock(text: string): string | null {
    const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (const match of fencedMatches) {
      const candidate = match[1]?.trim();
      if (!candidate) {
        continue;
      }
      const parsedCandidate = this.extractFirstJsonObject(candidate);
      if (parsedCandidate) {
        return parsedCandidate;
      }
    }

    return this.extractFirstJsonObject(text);
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

  private parseStructuredPayload(text: string): OpenAiRecommendationPayload | null {
    const jsonBlock = this.extractJsonBlock(text);
    if (!jsonBlock) {
      return null;
    }

    return JSON.parse(jsonBlock) as OpenAiRecommendationPayload;
  }

  private extractFirstJsonObject(text: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          start = index;
        }
        depth += 1;
        continue;
      }

      if (char !== '}' || depth === 0) {
        continue;
      }

      depth -= 1;
      if (depth !== 0 || start < 0) {
        continue;
      }

      const candidate = text.slice(start, index + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        start = -1;
      }
    }

    return null;
  }

  private normalizeDomains(items: OpenAiRecommendationItem[]): DomainMappingResult {
    const seen = new Set<string>();
    const result: RecommendedDomain[] = [];
    const mapped: Array<{ input: string; domainId: string; method: string }> = [];
    const unmapped: string[] = [];

    for (const item of items) {
      const candidates = uniqueKeepOrder([
        item.id?.trim() ?? '',
        item.name?.trim() ?? '',
        item.recommendationReason?.trim() ?? '',
        item.keywords.join(' ').trim(),
      ]).filter(Boolean);

      const mapping = this.resolveDomainId(candidates);
      if (!mapping) {
        unmapped.push(candidates.join(' | '));
        continue;
      }
      if (seen.has(mapping.domainId)) {
        continue;
      }
      const match = domainCatalog.find((domain) => domain.id === mapping.domainId);
      if (!match) {
        unmapped.push(candidates.join(' | '));
        continue;
      }

      seen.add(mapping.domainId);
      mapped.push({
        input: candidates[0],
        domainId: mapping.domainId,
        method: mapping.method,
      });
      result.push({
        id: match.id,
        name: match.title,
        shortDescription: match.shortDescription,
        recommendationReason: item.recommendationReason,
        keywords: item.keywords.slice(0, 6),
        relevance: item.relevance,
      });
    }

    return {
      domains: result.slice(0, 5),
      mapped,
      unmapped,
    };
  }

  private resolvePrimaryDomainId(primaryDomainId: string | undefined, domains: RecommendedDomain[]): string | null {
    if (primaryDomainId) {
      const resolved = this.resolveDomainId([primaryDomainId]);
      if (resolved) {
        return resolved.domainId;
      }
    }

    return domains[0]?.id ?? null;
  }

  private normalizeTaskSignals(rawSignals: string[], fallbackSignals: TaskSignal[]): SignalMappingResult<TaskSignal> {
    return this.normalizeSignals<TaskSignal>(
      rawSignals,
      fallbackSignals,
      taskCatalog.map((task) => ({
        id: task.id,
        labels: uniqueKeepOrder([task.id, task.title, ...(task.aliases ?? [])]),
      })),
    );
  }

  private normalizeModalitySignals(
    rawSignals: string[],
    fallbackSignals: ModalitySignal[],
  ): SignalMappingResult<ModalitySignal> {
    return this.normalizeSignals<ModalitySignal>(
      rawSignals,
      fallbackSignals,
      modalityCatalog.map((modality) => ({
        id: modality.id,
        labels: uniqueKeepOrder([modality.id, modality.title, ...(modality.aliases ?? [])]),
      })),
    );
  }

  private extractMentionedSignals<T extends string>(
    rawContent: string,
    catalog: Array<{ id: T; labels: string[] }>,
    fallbackSignals: T[],
  ): T[] {
    const extracted: T[] = catalog
      .filter((entry) =>
        entry.labels.some((label) => {
          const normalizedLabel = this.normalizeLabel(label);
          const normalizedRaw = this.normalizeLabel(rawContent);
          return normalizedRaw.includes(normalizedLabel);
        }),
      )
      .map((entry) => entry.id);

    return [...new Set<T>([...extracted, ...fallbackSignals])].slice(0, 3);
  }

  private normalizeSignals<T extends string>(
    rawSignals: string[],
    fallbackSignals: T[],
    catalog: Array<{ id: T; labels: string[] }>,
  ): SignalMappingResult<T> {
    const signals: T[] = [];
    const mapped: Array<{ input: string; id: T; method: string }> = [];
    const unmapped: string[] = [];

    for (const raw of rawSignals) {
      const resolved = this.resolveSignalId(raw, catalog);
      if (!resolved) {
        unmapped.push(raw);
        continue;
      }
      if (signals.includes(resolved.id)) {
        continue;
      }
      signals.push(resolved.id);
      mapped.push({ input: raw, id: resolved.id, method: resolved.method });
    }

    for (const fallback of fallbackSignals) {
      if (!signals.includes(fallback)) {
        signals.push(fallback);
      }
    }

    return {
      signals,
      mapped,
      unmapped,
    };
  }

  private resolveSignalId<T extends string>(
    candidate: string,
    catalog: Array<{ id: T; labels: string[] }>,
  ): { id: T; method: 'id' | 'alias' | 'similarity' } | null {
    const normalized = this.normalizeLabel(candidate);
    if (!normalized) {
      return null;
    }

    for (const entry of catalog) {
      for (const label of entry.labels) {
        const normalizedLabel = this.normalizeLabel(label);
        if (normalizedLabel === normalized) {
          return { id: entry.id, method: label === entry.id ? 'id' : 'alias' };
        }
        if (normalizedLabel.includes(normalized) || normalized.includes(normalizedLabel)) {
          return { id: entry.id, method: 'alias' };
        }
      }
    }

    const candidateTokens = new Set(tokenize(candidate));
    let best: { id: T; score: number } | null = null;
    for (const entry of catalog) {
      const labelTokens = new Set(tokenize(entry.labels.join(' ')));
      const overlap = [...candidateTokens].filter((token) => labelTokens.has(token)).length;
      const score = overlap / Math.max(candidateTokens.size, 1);
      if (score >= 0.45 && (!best || score > best.score)) {
        best = { id: entry.id, score };
      }
    }

    return best ? { id: best.id, method: 'similarity' } : null;
  }

  private resolveDomainId(
    candidates: string[],
  ): { domainId: string; method: 'id' | 'alias' | 'similarity' } | null {
    const aliasEntries = domainCatalog.flatMap((domain) => [
      { label: domain.id, domainId: domain.id, method: 'id' as const },
      { label: domain.title, domainId: domain.id, method: 'alias' as const },
      ...((domain.aliases ?? []).map((alias) => ({
        label: alias,
        domainId: domain.id,
        method: 'alias' as const,
      }))),
    ]);

    for (const candidate of candidates) {
      const normalized = this.normalizeLabel(candidate);
      if (!normalized) {
        continue;
      }

      const direct = aliasEntries.find((entry) => this.normalizeLabel(entry.label) === normalized);
      if (direct) {
        return { domainId: direct.domainId, method: direct.method };
      }

      const aliasContains = aliasEntries.find((entry) => {
        const normalizedAlias = this.normalizeLabel(entry.label);
        return normalizedAlias.includes(normalized) || normalized.includes(normalizedAlias);
      });
      if (aliasContains) {
        return { domainId: aliasContains.domainId, method: 'alias' };
      }
    }

    let bestMatch: { domainId: string; score: number } | null = null;
    for (const candidate of candidates) {
      const candidateTokens = new Set(tokenize(candidate));
      if (candidateTokens.size === 0) {
        continue;
      }
      for (const domain of domainCatalog) {
        const domainTokens = new Set(
          tokenize(
            domain.id,
            domain.title,
            domain.keywords.join(' '),
            (domain.aliases ?? []).join(' '),
          ),
        );
        const overlap = [...candidateTokens].filter((token) => domainTokens.has(token)).length;
        const score = overlap / Math.max(candidateTokens.size, 1);
        if (score >= 0.45 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { domainId: domain.id, score };
        }
      }
    }

    return bestMatch ? { domainId: bestMatch.domainId, method: 'similarity' } : null;
  }

  private normalizeLabel(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}
