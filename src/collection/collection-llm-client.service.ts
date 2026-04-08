import { Injectable } from '@nestjs/common';

type CollectionLlmJsonRequest = {
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
};

@Injectable()
export class CollectionLlmClientService {
  private readonly provider = (
    process.env.COLLECTION_LLM_PROVIDER ??
    process.env.LLM_PROVIDER ??
    'rule-based'
  )
    .trim()
    .toLowerCase();
  private readonly apiKey =
    process.env.COLLECTION_LLM_API_KEY?.trim() ??
    process.env.LLM_API_KEY?.trim() ??
    process.env.OPENAI_API_KEY?.trim() ??
    '';
  private readonly baseUrl = (
    process.env.COLLECTION_LLM_BASE_URL?.trim() ||
    process.env.LLM_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  private readonly model =
    process.env.COLLECTION_LLM_MODEL?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    'gpt-5-mini';
  private readonly apiMode =
    (process.env.COLLECTION_LLM_API_MODE?.trim().toLowerCase() ||
      process.env.LLM_API_MODE?.trim().toLowerCase() ||
      (this.provider === 'openai' ? 'responses' : 'chat_completions')) as 'responses' | 'chat_completions';
  private readonly timeoutMs = Number(
    process.env.COLLECTION_LLM_TIMEOUT_MS ??
      process.env.LLM_TIMEOUT_MS ??
      process.env.OPENAI_TIMEOUT_MS ??
      15000,
  );

  isConfigured(): boolean {
    if (this.provider === 'openai') {
      return this.apiKey.length > 0;
    }
    return (
      ['openai-compatible', 'vllm', 'openai'].includes(this.provider) &&
      this.baseUrl.length > 0 &&
      this.model.length > 0
    );
  }

  getSettings() {
    return {
      provider: this.provider,
      baseUrl: this.baseUrl,
      model: this.model,
      apiMode: this.apiMode,
      timeoutMs: this.timeoutMs,
    };
  }

  async requestJson(input: CollectionLlmJsonRequest): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Collection LLM provider configuration is incomplete.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return this.apiMode === 'responses'
        ? await this.callResponsesApi(input, controller.signal)
        : await this.callChatCompletions(input, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Collection LLM request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callResponsesApi(
    input: CollectionLlmJsonRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(this.responsesUrl(), {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: input.systemPrompt }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: input.userPrompt }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`collection LLM responses request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.extractOutputText(payload) ?? JSON.stringify(payload);
  }

  private async callChatCompletions(
    input: CollectionLlmJsonRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(this.chatCompletionsUrl(), {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        stream: false,
        temperature: 0,
        top_p: 1,
        max_tokens: 900,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
        extra_body: {
          guided_json: input.schema,
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`collection LLM chat request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content ?? '';
  }

  private buildHeaders(requireAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (requireAuth) {
      throw new Error('Collection LLM requires an API key for this provider.');
    }
    return headers;
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

  private responsesUrl(): string {
    const base = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}/responses`;
  }

  private chatCompletionsUrl(): string {
    const base = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}/chat/completions`;
  }
}
