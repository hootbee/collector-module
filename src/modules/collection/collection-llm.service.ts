import { Injectable } from '@nestjs/common';
import type {
  CollectionLlmPlan,
  CollectionSourceId,
  ModalitySignal,
  TaskSignal,
} from '../../common/contracts';
import { extractJsonBlock, previewLlmText } from './collection-llm.utils';
import { CollectionLlmClientService } from './collection-llm-client.service';

type ParsedLlmPlan = {
  rawOutput: string;
  plan: CollectionLlmPlan;
};

type RawLlmPlan = {
  canonicalIntent?: string;
  taskSignals?: string[];
  modalitySignals?: string[];
  mustInclude?: string[];
  mustAvoid?: string[];
  datasetSourceQueries?: Record<string, string[]>;
  knowledgeSourceQueries?: Record<string, string[]>;
  notes?: string[];
};

const datasetSources: CollectionSourceId[] = [
  'seed-catalog',
  'huggingface',
  'openml',
  'uci',
  'kaggle',
];

const knowledgeSources: CollectionSourceId[] = [
  'seed-catalog',
  'serpapi',
  'crossref',
];

const taskSignals: TaskSignal[] = [
  'classification',
  'regression',
  'anomaly-detection',
  'time-series-forecasting',
  'content-authenticity',
  'authorship-attribution',
];

const modalitySignals: ModalitySignal[] = [
  'tabular',
  'text',
  'time-series',
  'transaction',
  'longitudinal',
  'document',
];

@Injectable()
export class CollectionLlmService {
  private readonly enabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.COLLECTION_LLM_PLANNER_ENABLED ?? 'false').trim().toLowerCase(),
  );

  constructor(private readonly llmClient: CollectionLlmClientService) {}

  isEnabled(): boolean {
    if (!this.enabled) {
      return false;
    }
    return this.llmClient.isConfigured();
  }

  async planQueries(input: {
    query: string;
    kind: 'dataset' | 'knowledge' | 'both';
    requestedSources: CollectionSourceId[];
    taskSignals: TaskSignal[];
    modalitySignals: ModalitySignal[];
    datasetQueries: string[];
    knowledgeQueries: string[];
    mustInclude: string[];
    mustAvoid: string[];
  }): Promise<ParsedLlmPlan | null> {
    if (!this.enabled) {
      return null;
    }
    if (!this.llmClient.isConfigured()) {
      throw new Error('Collection LLM planner is enabled but LLM provider configuration is incomplete.');
    }

    try {
      const rawOutput = await this.llmClient.requestJson({
        schemaName: 'collection_query_plan',
        schema: this.schema(),
        systemPrompt: this.systemPrompt(),
        userPrompt: this.userPrompt(input),
      });
      const parsed = this.parsePlan(rawOutput, input);
      if (!parsed) {
        console.warn(
          `[CollectionLlmService] planner returned unparseable output: ${previewLlmText(rawOutput)}`,
        );
      }
      return parsed ? { rawOutput, plan: parsed } : null;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Collection LLM planner request failed: ${message}`);
    }
  }

  private systemPrompt(): string {
    return [
      'You assist only the collection module.',
      'Return only one JSON object.',
      'The first character must be "{" and the last character must be "}".',
      'Do not include analysis, markdown, code fences, or explanations.',
      'Do not invent URLs, datasets, papers, providers, or sources.',
      'Use only the provided source IDs.',
      'Your job is to refine source-aware search queries, include keywords, and avoid keywords.',
      'If uncertain, keep the deterministic baseline and make conservative adjustments.',
    ].join(' ');
  }

  private userPrompt(input: Parameters<CollectionLlmService['planQueries']>[0]): string {
    return [
      `query=${input.query}`,
      `kind=${input.kind}`,
      `requestedSources=${input.requestedSources.join(', ')}`,
      `deterministicTaskSignals=${input.taskSignals.join(', ') || '(none)'}`,
      `deterministicModalitySignals=${input.modalitySignals.join(', ') || '(none)'}`,
      `deterministicDatasetQueries=${input.datasetQueries.join(' | ') || '(none)'}`,
      `deterministicKnowledgeQueries=${input.knowledgeQueries.join(' | ') || '(none)'}`,
      `mustInclude=${input.mustInclude.join(', ') || '(none)'}`,
      `mustAvoid=${input.mustAvoid.join(', ') || '(none)'}`,
      `allowedDatasetSources=${datasetSources.join(', ')}`,
      `allowedKnowledgeSources=${knowledgeSources.join(', ')}`,
      `allowedTaskSignals=${taskSignals.join(', ')}`,
      `allowedModalitySignals=${modalitySignals.join(', ')}`,
      'Return exactly one JSON object with keys: canonicalIntent, taskSignals, modalitySignals, mustInclude, mustAvoid, datasetSourceQueries, knowledgeSourceQueries, notes.',
      'Only include datasetSourceQueries for requested sources that are dataset-capable.',
      'Only include knowledgeSourceQueries for requested sources that are knowledge-capable.',
      'Keep queries short, source-aware, and realistic.',
      'Do not write placeholder text such as "maybe", "for example", or "we need".',
    ].join('\n');
  }

  private schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'canonicalIntent',
        'taskSignals',
        'modalitySignals',
        'mustInclude',
        'mustAvoid',
        'datasetSourceQueries',
        'knowledgeSourceQueries',
        'notes',
      ],
      properties: {
        canonicalIntent: { type: 'string' },
        taskSignals: {
          type: 'array',
          items: { type: 'string', enum: taskSignals },
          maxItems: 4,
        },
        modalitySignals: {
          type: 'array',
          items: { type: 'string', enum: modalitySignals },
          maxItems: 4,
        },
        mustInclude: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 12,
        },
        mustAvoid: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 12,
        },
        datasetSourceQueries: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            datasetSources.map((source) => [source, { type: 'array', items: { type: 'string' }, maxItems: 8 }]),
          ),
        },
        knowledgeSourceQueries: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            knowledgeSources.map((source) => [source, { type: 'array', items: { type: 'string' }, maxItems: 8 }]),
          ),
        },
        notes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 6,
        },
      },
    };
  }

  private parsePlan(
    text: string,
    input: Parameters<CollectionLlmService['planQueries']>[0],
  ): CollectionLlmPlan | null {
    const jsonBlock = extractJsonBlock(text);
    if (!jsonBlock) {
      return this.parseLoosePlan(text, input);
    }
    try {
      const raw = JSON.parse(jsonBlock) as RawLlmPlan;
      return this.normalizePlan(raw, input);
    } catch {
      return this.parseLoosePlan(text, input);
    }
  }

  private normalizeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item).trim())
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  }

  private normalizePlan(
    raw: RawLlmPlan,
    input: Parameters<CollectionLlmService['planQueries']>[0],
  ): CollectionLlmPlan | null {
    const plan: CollectionLlmPlan = {
      canonicalIntent: raw.canonicalIntent?.trim() || input.query,
      taskSignals: this.normalizeSignals(raw.taskSignals, taskSignals, input.taskSignals),
      modalitySignals: this.normalizeSignals(raw.modalitySignals, modalitySignals, input.modalitySignals),
      mustInclude: this.normalizeStringArray(raw.mustInclude).slice(0, 12),
      mustAvoid: this.normalizeStringArray(raw.mustAvoid).slice(0, 12),
      datasetSourceQueries: this.normalizeQueryMap(raw.datasetSourceQueries, datasetSources),
      knowledgeSourceQueries: this.normalizeQueryMap(raw.knowledgeSourceQueries, knowledgeSources),
      notes: this.normalizeStringArray(raw.notes).slice(0, 6),
    };

    return this.hasMeaningfulPlan(plan) ? plan : null;
  }

  private parseLoosePlan(
    text: string,
    input: Parameters<CollectionLlmService['planQueries']>[0],
  ): CollectionLlmPlan | null {
    const plan: CollectionLlmPlan = {
      canonicalIntent:
        this.extractNamedString(text, 'canonicalIntent') ??
        this.extractQuotedNear(text, 'canonicalIntent') ??
        input.query,
      taskSignals: this.extractSignals(text, taskSignals, input.taskSignals),
      modalitySignals: this.extractSignals(text, modalitySignals, input.modalitySignals),
      mustInclude: this.extractNamedStringList(text, 'mustInclude').slice(0, 12),
      mustAvoid: this.extractNamedStringList(text, 'mustAvoid').slice(0, 12),
      datasetSourceQueries: Object.fromEntries(
        datasetSources.map((source) => [source, this.extractSourceQueries(text, source)]),
      ) as Partial<Record<CollectionSourceId, string[]>>,
      knowledgeSourceQueries: Object.fromEntries(
        knowledgeSources.map((source) => [source, this.extractSourceQueries(text, source)]),
      ) as Partial<Record<CollectionSourceId, string[]>>,
      notes: this.extractNamedStringList(text, 'notes').slice(0, 6),
    };

    if (!this.hasMeaningfulPlan(plan)) {
      return null;
    }
    if (plan.notes.length === 0) {
      plan.notes = ['salvaged-from-freeform-output'];
    }
    return plan;
  }

  private normalizeSignals<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: readonly T[],
  ): T[] {
    const normalized = this.normalizeStringArray(value)
      .map((entry) => this.normalizeSignalName(entry, allowed))
      .filter((entry): entry is T => entry != null);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  private normalizeSignalName<T extends string>(value: string, allowed: readonly T[]): T | null {
    const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
    for (const candidate of allowed) {
      const candidateNormalized = candidate.toLowerCase();
      const candidateSpaced = candidateNormalized.replace(/-/g, ' ');
      if (
        normalized === candidateNormalized ||
        normalized === candidateSpaced ||
        normalized.includes(candidateNormalized) ||
        normalized.includes(candidateSpaced)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private extractSignals<T extends string>(text: string, allowed: readonly T[], fallback: readonly T[]): T[] {
    const lowered = text.toLowerCase();
    const matched = allowed.filter((candidate) => {
      const variants = [candidate.toLowerCase(), candidate.toLowerCase().replace(/-/g, ' ')];
      return variants.some((variant) => lowered.includes(variant));
    });
    return matched.length > 0 ? matched : [...fallback];
  }

  private extractNamedString(text: string, key: string): string | null {
    const escapedKey = this.escapeRegExp(key);
    const quoted = new RegExp(`${escapedKey}\\s*[:=]\\s*"([^"]+)"`, 'i').exec(text);
    if (quoted?.[1]?.trim()) {
      return quoted[1].trim();
    }
    const singleQuoted = new RegExp(`${escapedKey}\\s*[:=]\\s*'([^']+)'`, 'i').exec(text);
    if (singleQuoted?.[1]?.trim()) {
      return singleQuoted[1].trim();
    }
    const plain = new RegExp(`${escapedKey}\\s*[:=]\\s*([^\\n\\r,}]+)`, 'i').exec(text);
    return plain?.[1]?.trim() || null;
  }

  private extractQuotedNear(text: string, key: string): string | null {
    const escapedKey = this.escapeRegExp(key);
    const match = new RegExp(`${escapedKey}[\\s\\S]{0,160}?"([^"]{6,200})"`, 'i').exec(text);
    return match?.[1]?.trim() || null;
  }

  private extractNamedStringList(text: string, key: string): string[] {
    const escapedKey = this.escapeRegExp(key);
    const arrayMatch = new RegExp(`${escapedKey}\\s*[:=]\\s*\\[([\\s\\S]{0,400}?)\\]`, 'i').exec(text);
    if (arrayMatch?.[1]) {
      return this.extractQuotedStrings(arrayMatch[1]).slice(0, 12);
    }
    const lineMatch = new RegExp(`${escapedKey}\\s*[:=]\\s*([^\\n\\r}]+)`, 'i').exec(text);
    if (!lineMatch?.[1]) {
      return [];
    }
    return lineMatch[1]
      .split(/,|\|/)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  private extractSourceQueries(text: string, source: CollectionSourceId): string[] {
    const escapedSource = this.escapeRegExp(source);
    const arrayMatch = new RegExp(`${escapedSource}\\s*[:=]\\s*\\[([\\s\\S]{0,500}?)\\]`, 'i').exec(text);
    if (arrayMatch?.[1]) {
      return this.extractQuotedStrings(arrayMatch[1]).slice(0, 8);
    }
    const lineMatch = new RegExp(`${escapedSource}\\s*[:=]\\s*([^\\n\\r}]+)`, 'i').exec(text);
    if (!lineMatch?.[1]) {
      return [];
    }
    return lineMatch[1]
      .split(/,|\|/)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter((item) => item.length >= 3 && !/^(none|n\/a|null)$/i.test(item))
      .slice(0, 8);
  }

  private extractQuotedStrings(text: string): string[] {
    return [...text.matchAll(/"([^"]+)"|'([^']+)'/g)]
      .map((match) => (match[1] ?? match[2] ?? '').trim())
      .filter(Boolean);
  }

  private hasMeaningfulPlan(plan: CollectionLlmPlan): boolean {
    return Boolean(
      plan.canonicalIntent.trim() ||
        plan.mustInclude.length > 0 ||
        plan.mustAvoid.length > 0 ||
        plan.notes.length > 0 ||
        Object.values(plan.datasetSourceQueries).some((items) => (items ?? []).length > 0) ||
        Object.values(plan.knowledgeSourceQueries).some((items) => (items ?? []).length > 0),
    );
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeQueryMap<T extends CollectionSourceId>(
    value: Record<string, string[]> | undefined,
    allowedSources: T[],
  ): Partial<Record<T, string[]>> {
    if (!value || typeof value !== 'object') {
      return {};
    }
    const result: Partial<Record<T, string[]>> = {};
    for (const source of allowedSources) {
      const sourceValue: unknown = value[source];
      const queries = Array.isArray(sourceValue)
        ? sourceValue.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 8)
        : typeof sourceValue === 'string'
          ? sourceValue
              .split(/\n|,/)
              .map((item: string) => item.trim())
              .filter(Boolean)
              .slice(0, 8)
          : [];
      if (queries.length > 0) {
        result[source] = queries;
      }
    }
    return result;
  }

}
