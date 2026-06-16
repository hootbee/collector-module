import { Injectable } from '@nestjs/common';
import type { ExternalDatasetItem, ExternalKnowledgeItem } from '../../common/contracts';
import { CollectionLlmClientService } from './collection-llm-client.service';

const DATASET_USAGE_OPTIONS = [
  '정합성 비교 대상',
  '참조 벤치마크',
  '보조 특징만 발췌',
] as const;

const KNOWLEDGE_USAGE_OPTIONS = [
  '라벨·정의 근거',
  '포함·제외 기준',
  '방법론 참고',
] as const;

export type ResourcePlanDatasetEntry = {
  useForMatching: boolean;
  extractVariables: string;
  extractLabel: string;
  rowUnit: string;
  usagePurpose: string;
  notes: string;
  llmSuggested?: boolean;
};

export type ResourcePlanKnowledgeEntry = {
  useInMatching: boolean;
  extractPoints: string;
  usagePurpose: string;
  notes: string;
  llmSuggested?: boolean;
};

export type SearchResourcePlanSuggestion = {
  datasets: Record<string, ResourcePlanDatasetEntry>;
  knowledge: Record<string, ResourcePlanKnowledgeEntry>;
  globalNotes: string;
  llmUsed: boolean;
  planSource: 'llm' | 'rule';
};

type DomainFormInput = {
  industry?: string;
  subdomain?: string;
  data_modality?: string;
  row_unit?: string;
  ml_task?: string;
  target_event?: string;
  include_scope?: string;
  exclude_scope?: string;
};

type CurrentDataContext = {
  fileName?: string;
  columnNames?: string[];
  featureColumns?: string[];
  targetColumn?: string | null;
  targetLabel?: string | null;
  rowCount?: number | null;
  diagnosisSummary?: string;
  dataModality?: string;
  rowUnit?: string;
  mlTask?: string;
  targetEvent?: string;
  includeScope?: string;
  excludeScope?: string;
  classDistribution?: string;
};

const TOKEN_GROUPS = [
  ['hr', 'heart', 'pulse', '심박'],
  ['bp', 'blood', 'pressure', '혈압'],
  ['temp', 'temperature', '체온'],
  ['spo2', 'oxygen', 'sat'],
  ['lab', 'creatinine', 'glucose', 'bun', 'crp'],
  ['age', '연령', '나이'],
  ['sex', 'gender', '성별'],
  ['label', 'target', 'outcome', 'event', '라벨', '이벤트'],
];

@Injectable()
export class CollectionResourcePlanService {
  constructor(private readonly llmClient: CollectionLlmClientService) {}

  async suggestResourcePlan(input: {
    datasetItems?: ExternalDatasetItem[];
    knowledgeItems?: ExternalKnowledgeItem[];
    domainForm?: DomainFormInput | null;
    currentData?: CurrentDataContext | null;
  }): Promise<SearchResourcePlanSuggestion> {
    const datasetItems = (input.datasetItems ?? []).slice(0, 8);
    const knowledgeItems = (input.knowledgeItems ?? []).slice(0, 8);
    const currentData = input.currentData ?? {};
    const fallback = this.buildRuleBasedPlan(
      datasetItems,
      knowledgeItems,
      currentData,
      input.domainForm ?? {},
    );

    if (!this.llmClient.isConfigured() || (datasetItems.length === 0 && knowledgeItems.length === 0)) {
      return fallback;
    }

    try {
      const llmPlan = await this.requestLlmResourcePlan(
        datasetItems,
        knowledgeItems,
        input.domainForm ?? {},
        input.currentData ?? {},
      );
      return this.mergePlans(fallback, llmPlan, true);
    } catch {
      return fallback;
    }
  }

  private buildRuleBasedPlan(
    datasetItems: ExternalDatasetItem[],
    knowledgeItems: ExternalKnowledgeItem[],
    currentData: CurrentDataContext,
    domainForm: DomainFormInput,
  ): SearchResourcePlanSuggestion {
    const datasets: Record<string, ResourcePlanDatasetEntry> = {};
    datasetItems.forEach((item, index) => {
      if (!item.id) return;
      const keywords = Array.isArray(item.matchedKeywords) ? item.matchedKeywords : [];
      const hasUserColumns = (currentData.columnNames?.length ?? 0) > 0;
      datasets[item.id] = {
        useForMatching: index < 3,
        extractVariables: hasUserColumns
          ? this.suggestExtractVariables(item, currentData)
          : keywords.slice(0, 6).join(', '),
        extractLabel: this.suggestExtractLabel(currentData),
        rowUnit: String(currentData.rowUnit || domainForm.row_unit || item.rowsHint || '').trim(),
        usagePurpose: index === 0 ? DATASET_USAGE_OPTIONS[0] : DATASET_USAGE_OPTIONS[1],
        notes: hasUserColumns
          ? `내 데이터 컬럼(${(currentData.columnNames ?? []).slice(0, 4).join(', ')}) 기준 발췌`
          : String(item.matchedReason ?? '').trim(),
        llmSuggested: false,
      };
    });

    const knowledge: Record<string, ResourcePlanKnowledgeEntry> = {};
    knowledgeItems.forEach((item, index) => {
      if (!item.id) return;
      const keywords = Array.isArray(item.matchedKeywords) ? item.matchedKeywords : [];
      const summary = String(item.summary ?? '').trim();
      const targetHint = this.suggestExtractLabel(currentData);
      knowledge[item.id] = {
        useInMatching: index < 2,
        extractPoints: summary
          ? summary.slice(0, 240)
          : [targetHint ? `타깃 정의: ${targetHint}` : '', keywords.slice(0, 4).join(', ')].filter(Boolean).join(' · '),
        usagePurpose: KNOWLEDGE_USAGE_OPTIONS[0],
        notes: targetHint
          ? `내 데이터 타깃(${targetHint}) 정의 근거`
          : String(item.matchedReason ?? '').trim(),
        llmSuggested: false,
      };
    });

    return {
      datasets,
      knowledge,
      globalNotes: '',
      llmUsed: false,
      planSource: 'rule',
    };
  }

  private mergePlans(
    base: SearchResourcePlanSuggestion,
    llm: SearchResourcePlanSuggestion,
    llmUsed: boolean,
  ): SearchResourcePlanSuggestion {
    const datasets = { ...base.datasets };
    Object.entries(llm.datasets).forEach(([id, entry]) => {
      datasets[id] = {
        ...(datasets[id] ?? entry),
        ...entry,
        llmSuggested: llmUsed,
      };
    });

    const knowledge = { ...base.knowledge };
    Object.entries(llm.knowledge).forEach(([id, entry]) => {
      knowledge[id] = {
        ...(knowledge[id] ?? entry),
        ...entry,
        llmSuggested: llmUsed,
      };
    });

    return {
      datasets,
      knowledge,
      globalNotes: llm.globalNotes || base.globalNotes,
      llmUsed,
      planSource: llmUsed ? 'llm' : 'rule',
    };
  }

  private async requestLlmResourcePlan(
    datasetItems: ExternalDatasetItem[],
    knowledgeItems: ExternalKnowledgeItem[],
    domainForm: DomainFormInput,
    currentData: CurrentDataContext,
  ): Promise<SearchResourcePlanSuggestion> {
    const datasetLines = datasetItems.map((item, index) => [
      `- id=${item.id}`,
      `  name=${item.name}`,
      `  provider=${item.provider}`,
      `  modality=${item.modality}`,
      `  rows_hint=${item.rowsHint}`,
      `  description=${item.description}`,
      `  keywords=${(item.matchedKeywords ?? []).join(', ')}`,
      `  default_use_for_matching=${index < 3}`,
    ].join('\n'));

    const knowledgeLines = knowledgeItems.map((item, index) => [
      `- id=${item.id}`,
      `  title=${item.title}`,
      `  source=${item.source}`,
      `  kind=${item.kind}`,
      `  summary=${item.summary}`,
      `  keywords=${(item.matchedKeywords ?? []).join(', ')}`,
      `  default_use_in_matching=${index < 2}`,
    ].join('\n'));

    const raw = await this.llmClient.requestJson({
      schemaName: 'search_resource_plan_suggestions',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          global_notes: { type: 'string' },
          datasets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                use_for_matching: { type: 'boolean' },
                extract_variables: { type: 'string' },
                extract_label: { type: 'string' },
                row_unit: { type: 'string' },
                usage_purpose: { type: 'string' },
                notes: { type: 'string' },
              },
              required: [
                'id',
                'use_for_matching',
                'extract_variables',
                'extract_label',
                'row_unit',
                'usage_purpose',
                'notes',
              ],
            },
          },
          knowledge: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                use_in_matching: { type: 'boolean' },
                extract_points: { type: 'string' },
                usage_purpose: { type: 'string' },
                notes: { type: 'string' },
              },
              required: ['id', 'use_in_matching', 'extract_points', 'usage_purpose', 'notes'],
            },
          },
        },
        required: ['global_notes', 'datasets', 'knowledge'],
      },
      systemPrompt: [
        'You help ML practitioners decide what to extract from external dataset and knowledge candidates.',
        'Suggest concrete variable/column names, label/event definitions, row units, and knowledge excerpts',
        'that align with the current project domain and connected dataset.',
        'CRITICAL: extract_variables must be chosen relative to the user connected dataset columns.',
        'Prefer external variables that complement missing features in the user columns,',
        'and include variables mappable to existing user feature columns for consistency checking.',
        'Do not suggest generic keywords unrelated to the user schema.',
        'extract_label must align with the user target_column/target_label when present.',
        'Write Korean for usage_purpose, notes, extract_points, and global_notes.',
        'extract_variables should be comma-separated candidate column/feature names.',
        'extract_label should name the label column or event definition to compare in matching step.',
        'usage_purpose for datasets must be one of:',
        DATASET_USAGE_OPTIONS.join(', '),
        'usage_purpose for knowledge must be one of:',
        KNOWLEDGE_USAGE_OPTIONS.join(', '),
        'Return one entry per provided id. Do not invent new ids.',
      ].join(' '),
      userPrompt: [
        '## Current connected data (must guide every extract_variables choice)',
        `file: ${currentData.fileName ?? '(unknown)'}`,
        `columns: ${(currentData.columnNames ?? []).join(', ') || '(unknown)'}`,
        `feature_columns: ${(currentData.featureColumns ?? []).join(', ') || '(unknown)'}`,
        `target_column: ${currentData.targetColumn ?? '(unknown)'}`,
        `target_label: ${currentData.targetLabel ?? '(unknown)'}`,
        `row_unit: ${currentData.rowUnit ?? domainForm.row_unit ?? '(unknown)'}`,
        `data_modality: ${currentData.dataModality ?? domainForm.data_modality ?? '(unknown)'}`,
        `row_count: ${currentData.rowCount ?? '(unknown)'}`,
        `class_distribution: ${currentData.classDistribution ?? '(unknown)'}`,
        `diagnosis: ${currentData.diagnosisSummary ?? '(none)'}`,
        '',
        '## Domain form',
        `industry: ${domainForm.industry ?? ''}`,
        `subdomain: ${domainForm.subdomain ?? ''}`,
        `data_modality: ${domainForm.data_modality ?? ''}`,
        `row_unit: ${domainForm.row_unit ?? ''}`,
        `ml_task: ${domainForm.ml_task ?? ''}`,
        `target_event: ${domainForm.target_event ?? ''}`,
        `include_scope: ${domainForm.include_scope ?? ''}`,
        `exclude_scope: ${domainForm.exclude_scope ?? ''}`,
        '',
        '## Dataset candidates',
        datasetLines.length ? datasetLines.join('\n') : '(none)',
        '',
        '## Knowledge candidates',
        knowledgeLines.length ? knowledgeLines.join('\n') : '(none)',
      ].join('\n'),
    });

    const parsed = JSON.parse(raw) as {
      global_notes?: string;
      datasets?: Array<{
        id?: string;
        use_for_matching?: boolean;
        extract_variables?: string;
        extract_label?: string;
        row_unit?: string;
        usage_purpose?: string;
        notes?: string;
      }>;
      knowledge?: Array<{
        id?: string;
        use_in_matching?: boolean;
        extract_points?: string;
        usage_purpose?: string;
        notes?: string;
      }>;
    };

    const allowedDatasetIds = new Set(datasetItems.map((item) => item.id));
    const allowedKnowledgeIds = new Set(knowledgeItems.map((item) => item.id));

    const datasets: Record<string, ResourcePlanDatasetEntry> = {};
    (parsed.datasets ?? []).forEach((item) => {
      const id = String(item.id ?? '').trim();
      if (!id || !allowedDatasetIds.has(id)) return;
      datasets[id] = {
        useForMatching: Boolean(item.use_for_matching),
        extractVariables: String(item.extract_variables ?? '').trim(),
        extractLabel: String(item.extract_label ?? '').trim(),
        rowUnit: String(item.row_unit ?? '').trim(),
        usagePurpose: this.normalizeDatasetUsage(String(item.usage_purpose ?? '').trim()),
        notes: String(item.notes ?? '').trim(),
        llmSuggested: true,
      };
    });

    const knowledge: Record<string, ResourcePlanKnowledgeEntry> = {};
    (parsed.knowledge ?? []).forEach((item) => {
      const id = String(item.id ?? '').trim();
      if (!id || !allowedKnowledgeIds.has(id)) return;
      knowledge[id] = {
        useInMatching: Boolean(item.use_in_matching),
        extractPoints: String(item.extract_points ?? '').trim(),
        usagePurpose: this.normalizeKnowledgeUsage(String(item.usage_purpose ?? '').trim()),
        notes: String(item.notes ?? '').trim(),
        llmSuggested: true,
      };
    });

    return {
      datasets,
      knowledge,
      globalNotes: String(parsed.global_notes ?? '').trim(),
      llmUsed: true,
      planSource: 'llm',
    };
  }

  private normalizeDatasetUsage(value: string): string {
    if (DATASET_USAGE_OPTIONS.includes(value as typeof DATASET_USAGE_OPTIONS[number])) {
      return value;
    }
    return DATASET_USAGE_OPTIONS[0];
  }

  private normalizeKnowledgeUsage(value: string): string {
    if (KNOWLEDGE_USAGE_OPTIONS.includes(value as typeof KNOWLEDGE_USAGE_OPTIONS[number])) {
      return value;
    }
    return KNOWLEDGE_USAGE_OPTIONS[0];
  }

  private normalizeToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
  }

  private tokensRelated(a: string, b: string): boolean {
    const left = this.normalizeToken(a);
    const right = this.normalizeToken(b);
    if (!left || !right) return false;
    if (left === right || left.includes(right) || right.includes(left)) return true;
    return TOKEN_GROUPS.some(
      (group) => group.some((term) => left.includes(term)) && group.some((term) => right.includes(term)),
    );
  }

  private collectCandidateTokens(item: ExternalDatasetItem): string[] {
    const keywords = Array.isArray(item.matchedKeywords) ? item.matchedKeywords : [];
    const descriptionTokens = String(item.description ?? '')
      .split(/[,;·|/]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    return [...new Set([...keywords, ...descriptionTokens])].filter(Boolean);
  }

  private suggestExtractLabel(currentData: CurrentDataContext): string {
    const targetColumn = String(currentData.targetColumn ?? '').trim();
    const targetLabel = String(currentData.targetLabel ?? '').trim();
    if (targetColumn && targetLabel) return `${targetColumn}=${targetLabel}`;
    if (targetColumn) return targetColumn;
    if (currentData.targetEvent) return String(currentData.targetEvent).trim();
    return '';
  }

  private suggestExtractVariables(item: ExternalDatasetItem, currentData: CurrentDataContext): string {
    const userColumns = currentData.columnNames ?? [];
    const targetColumn = String(currentData.targetColumn ?? '').trim();
    const featureColumns = (currentData.featureColumns?.length
      ? currentData.featureColumns
      : userColumns.filter((column) => column && column !== targetColumn));
    const keywords = this.collectCandidateTokens(item);

    const complementary: string[] = [];
    const aligned: string[] = [];

    keywords.forEach((keyword) => {
      const relatedColumn = featureColumns.find((column) => this.tokensRelated(column, keyword));
      if (relatedColumn) {
        if (!aligned.includes(keyword)) aligned.push(keyword);
      } else if (!complementary.includes(keyword)) {
        complementary.push(keyword);
      }
    });

    let picked = complementary.slice(0, 4);
    if (picked.length < 2) {
      picked = [...picked, ...aligned.slice(0, Math.max(0, 4 - picked.length))];
    }
    if (picked.length < 2 && featureColumns.length) {
      picked = [...picked, ...featureColumns.slice(0, Math.max(0, 4 - picked.length))];
    }
    if (!picked.length) {
      return keywords.slice(0, 6).join(', ');
    }
    return [...new Set(picked)].slice(0, 6).join(', ');
  }
}
