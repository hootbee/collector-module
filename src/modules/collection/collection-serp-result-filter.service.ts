import { Injectable } from '@nestjs/common';
import type { DiscoveryContext } from '../../common/contracts';
import { tokenize } from '../../common/text';
import { envFlag, envNumber } from './connectors/connector.utils';
import { CollectionLlmClientService } from './collection-llm-client.service';
import { extractJsonBlock, previewLlmText } from './collection-llm.utils';
import type { DiscoveryPlan } from './types/collection-plan';
import type { DatasetDiscoveryHit, KnowledgeDiscoveryHit } from './types/collection-hit';

type RawSemanticFilterResponse = {
  dropIds?: string[];
  notes?: string[];
};

@Injectable()
export class CollectionSerpResultFilterService {
  private readonly semanticEnabled = envFlag('COLLECTION_SERP_FILTER_LLM_ENABLED', false);
  private readonly strictFailure = envFlag('COLLECTION_SERP_FILTER_LLM_STRICT', false);
  private readonly highRecallMode = envFlag('COLLECTION_SERP_FILTER_HIGH_RECALL', true);
  private readonly batchLimit = Math.max(3, Math.min(envNumber('COLLECTION_SERP_FILTER_LLM_BATCH_LIMIT', 8), 12));

  constructor(private readonly llmClient: CollectionLlmClientService) {}

  async filterDatasetHits(
    hits: DatasetDiscoveryHit[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DatasetDiscoveryHit[]> {
    return this.filterHits('dataset', hits, plan, context);
  }

  async filterKnowledgeHits(
    hits: KnowledgeDiscoveryHit[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<KnowledgeDiscoveryHit[]> {
    return this.filterHits('knowledge', hits, plan, context);
  }

  private async filterHits<T extends DatasetDiscoveryHit | KnowledgeDiscoveryHit>(
    kind: 'dataset' | 'knowledge',
    hits: T[],
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<T[]> {
    const ruleFiltered = hits.filter((hit) => !this.isObviousNoise(hit, kind, plan));
    if (!this.semanticEnabled || ruleFiltered.length === 0) {
      return ruleFiltered;
    }
    if (!this.llmClient.isConfigured()) {
      const message = 'Serp semantic filter is enabled but collection LLM is not configured.';
      if (this.strictFailure) {
        throw new Error(message);
      }
      console.warn(`[CollectionSerpResultFilterService] ${message}`);
      return ruleFiltered;
    }

    try {
      const batch = ruleFiltered.slice(0, this.batchLimit);
      const rawOutput = await this.llmClient.requestJson({
        schemaName: 'collection_serp_result_filter',
        schema: this.schema(batch.map((hit) => hit.id)),
        systemPrompt: this.systemPrompt(kind),
        userPrompt: this.userPrompt(kind, batch, plan, context),
      });
      const parsed = this.parseFilterResponse(rawOutput, batch.map((hit) => hit.id));
      if (!parsed) {
        console.warn(
          `[CollectionSerpResultFilterService] semantic filter returned unparseable output: ${previewLlmText(rawOutput)}`,
        );
        return ruleFiltered;
      }
      const dropIds = new Set(parsed.dropIds ?? []);
      return ruleFiltered.filter((hit) => !dropIds.has(hit.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.strictFailure) {
        throw new Error(`Serp semantic filter failed: ${message}`);
      }
      console.warn(`[CollectionSerpResultFilterService] semantic filter soft-failed: ${message}`);
      return ruleFiltered;
    }
  }

  private isObviousNoise(
    hit: DatasetDiscoveryHit | KnowledgeDiscoveryHit,
    kind: 'dataset' | 'knowledge',
    plan: DiscoveryPlan,
  ): boolean {
    const url = hit.entry.sourceUrl?.toLowerCase() ?? '';
    const title = hit.title.toLowerCase();
    const text = `${hit.title} ${hit.text} ${hit.entry.sourceUrl ?? ''}`.toLowerCase();
    const noisePatterns = [
      '/login',
      '/signin',
      '/sign-in',
      '/signup',
      '/sign-up',
      '/register',
      '/account',
      '/pricing',
      '/careers',
      '/contact',
      '/privacy',
      '/terms',
      '/advertis',
      '/sponsors',
      '/support',
      '/cookie',
    ];
    if (noisePatterns.some((pattern) => url.includes(pattern) || title.includes(pattern) || text.includes(pattern))) {
      return true;
    }

    const overlap = this.queryOverlap(text, kind === 'dataset' ? plan.datasetQueries : plan.knowledgeQueries, plan.mustInclude);
    if (overlap > 0) {
      return false;
    }

    if (kind === 'dataset') {
      const datasetHints = ['dataset', 'corpus', 'benchmark', 'csv', 'parquet', 'json', 'download', 'data', 'archive'];
      const hostHints = ['huggingface', 'kaggle', 'openml', 'uci', 'github', 'gist', 'zenodo'];
      if (datasetHints.some((hint) => text.includes(hint)) || hostHints.some((hint) => url.includes(hint))) {
        return false;
      }
      if (this.highRecallMode) {
        return false;
      }
      return /press release|sponsored|advertorial|coupon/i.test(text);
    }

    return /shop|product page|pricing|download app|newsletter/i.test(text);
  }

  private queryOverlap(text: string, queries: string[], mustInclude: string[]): number {
    const textTokens = new Set(tokenize(text));
    let score = 0;
    for (const query of queries.slice(0, 6)) {
      const tokens = tokenize(query);
      if (tokens.some((token) => textTokens.has(token))) {
        score += 1;
      }
    }
    for (const keyword of mustInclude.slice(0, 8)) {
      if (tokenize(keyword).some((token) => textTokens.has(token))) {
        score += 1;
      }
    }
    return score;
  }

  private systemPrompt(kind: 'dataset' | 'knowledge'): string {
    return [
      'You assist only the collection module Serp result triage layer.',
      'Return only one JSON object.',
      'Do not invent new ids or URLs.',
      `Only drop results that are clearly irrelevant for ${kind} collection intent.`,
      'Be conservative. Prefer keeping borderline results rather than dropping them.',
      'Drop only obvious noise such as login pages, pricing pages, ads, support portals, or clearly off-topic links.',
    ].join(' ');
  }

  private userPrompt(
    kind: 'dataset' | 'knowledge',
    hits: Array<DatasetDiscoveryHit | KnowledgeDiscoveryHit>,
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): string {
    const hitLines = hits.map((hit) =>
      JSON.stringify({
        id: hit.id,
        title: hit.title,
        url: hit.entry.sourceUrl,
        provider: 'provider' in hit.entry ? hit.entry.provider : hit.entry.source,
        snippet: hit.text.slice(0, 220),
        matchedQueries: hit.matchedQueries,
        matchedTerms: hit.matchedTerms,
      }),
    );

    return [
      `kind=${kind}`,
      `taskSignals=${context.taskSignals.join(', ') || '(none)'}`,
      `modalitySignals=${context.modalitySignals.join(', ') || '(none)'}`,
      `datasetQueries=${plan.datasetQueries.join(' | ') || '(none)'}`,
      `knowledgeQueries=${plan.knowledgeQueries.join(' | ') || '(none)'}`,
      `mustInclude=${plan.mustInclude.join(', ') || '(none)'}`,
      `mustAvoid=${plan.mustAvoid.join(', ') || '(none)'}`,
      'Candidates:',
      ...hitLines,
      'Return exactly one JSON object with keys: dropIds, notes.',
      'dropIds must be a subset of the provided ids.',
    ].join('\n');
  }

  private schema(ids: string[]): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['dropIds', 'notes'],
      properties: {
        dropIds: {
          type: 'array',
          items: { type: 'string', enum: ids },
          maxItems: Math.max(1, ids.length),
        },
        notes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 6,
        },
      },
    };
  }

  private parseFilterResponse(rawOutput: string, ids: string[]): RawSemanticFilterResponse | null {
    const jsonBlock = extractJsonBlock(rawOutput);
    if (!jsonBlock) {
      return null;
    }
    try {
      const parsed = JSON.parse(jsonBlock) as RawSemanticFilterResponse;
      const allowedIds = new Set(ids);
      return {
        dropIds: Array.isArray(parsed.dropIds)
          ? parsed.dropIds.map((item) => String(item).trim()).filter((item) => allowedIds.has(item))
          : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes.map((item) => String(item).trim()).filter(Boolean) : [],
      };
    } catch {
      return null;
    }
  }
}
