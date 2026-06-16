import { Injectable } from '@nestjs/common';
import type { DataSourceAnalysisResult } from '../data-sources/data-source-analysis.service';
import { DataSourceAnalysisService } from '../data-sources/data-source-analysis.service';
import { CollectionLlmClientService } from '../modules/collection/collection-llm-client.service';
import { DataSourcesService } from '../data-sources/data-sources.service';

export type AddonCatalogItem = {
  id: string;
  parentCoreModule: string;
  label: string;
  description: string;
};

export type AddonRecommendationTier = 'priority' | 'recommend' | 'optional' | 'weak' | 'none';

export type AddonRecommendationItem = {
  addonId: string;
  tier: AddonRecommendationTier;
  reason: string;
  condition: string;
  rank: number;
};

export type AddonRecommendationResponse = {
  items: AddonRecommendationItem[];
  byId: Record<string, AddonRecommendationItem>;
  llmUsed: boolean;
  analysisSummary?: string;
};

const TIER_RANK: Record<AddonRecommendationTier, number> = {
  priority: 4,
  recommend: 3,
  optional: 2,
  weak: 1,
  none: 0,
};

const EMPTY_DOMAIN_FORM: DataSourceAnalysisResult['domainForm'] = {
  industry: '',
  subdomain: '',
  data_modality: '',
  row_unit: '',
  ml_task: '',
  target_event: '',
  include_scope: '',
  exclude_scope: '',
};

@Injectable()
export class AddonRecommendationService {
  constructor(
    private readonly analysisService: DataSourceAnalysisService,
    private readonly dataSourcesService: DataSourcesService,
    private readonly llmClient: CollectionLlmClientService,
  ) {}

  async recommendAddons(
    actorUserId: string,
    input: {
      dataSourceId?: string | null;
      analysis?: Partial<DataSourceAnalysisResult> | null;
      addons: AddonCatalogItem[];
    },
  ): Promise<AddonRecommendationResponse> {
    const addons = (input.addons ?? []).filter((item) => item?.id?.trim());
    if (addons.length === 0) {
      return { items: [], byId: {}, llmUsed: false };
    }

    let analysis = this.normalizeAnalysis(input.analysis ?? null);
    if (input.dataSourceId?.trim()) {
      await this.dataSourcesService.get(input.dataSourceId.trim(), actorUserId);
      const shouldRefreshAnalysis =
        !analysis?.diagnosisSummary?.trim() || (analysis.columnNames?.length ?? 0) === 0;
      if (shouldRefreshAnalysis) {
        try {
          analysis = this.normalizeAnalysis(
            await this.analysisService.analyzeUploadedDataSource(input.dataSourceId.trim()),
          );
        } catch {
          analysis = analysis ?? null;
        }
      }
    }

    const llmUsed = this.llmClient.isConfigured() && Boolean(analysis?.diagnosisSummary?.trim());
    let items: AddonRecommendationItem[];
    if (llmUsed && analysis) {
      try {
        items = await this.requestLlmRecommendations(addons, analysis);
      } catch {
        items = this.ruleBasedRecommendations(addons, analysis);
      }
    } else {
      items = this.ruleBasedRecommendations(addons, analysis);
    }

    const byId = Object.fromEntries(items.map((item) => [item.addonId, item]));
    return {
      items,
      byId,
      llmUsed,
      analysisSummary: analysis?.diagnosisSummary ?? undefined,
    };
  }

  private normalizeAnalysis(
    analysis: Partial<DataSourceAnalysisResult> | null,
  ): DataSourceAnalysisResult | null {
    if (!analysis) return null;
    return {
      dataSourceId: analysis.dataSourceId ?? '',
      fileName: analysis.fileName ?? '(unknown)',
      rowCountEstimate: analysis.rowCountEstimate ?? null,
      columnNames: Array.isArray(analysis.columnNames) ? analysis.columnNames : [],
      domainForm: {
        ...EMPTY_DOMAIN_FORM,
        ...(analysis.domainForm ?? {}),
      },
      domainIndustryContext: analysis.domainIndustryContext ?? null,
      domainSubjectScope: analysis.domainSubjectScope ?? null,
      domainRegulationScope: analysis.domainRegulationScope ?? null,
      domainStakeholderNotes: analysis.domainStakeholderNotes ?? null,
      rowsLabel: analysis.rowsLabel ?? null,
      dataModality: analysis.dataModality ?? null,
      rowUnit: analysis.rowUnit ?? null,
      diagnosisSummary: analysis.diagnosisSummary ?? '',
      collectionQuery: analysis.collectionQuery ?? '',
      llmUsed: Boolean(analysis.llmUsed),
      targetColumn: analysis.targetColumn ?? null,
      targetLabel: analysis.targetLabel ?? null,
    };
  }

  private async requestLlmRecommendations(
    addons: AddonCatalogItem[],
    analysis: DataSourceAnalysisResult,
  ): Promise<AddonRecommendationItem[]> {
    const addonLines = addons.map(
      (addon) => `- ${addon.id} | stage=${addon.parentCoreModule} | ${addon.label}: ${addon.description}`,
    );
    const columnNames = Array.isArray(analysis.columnNames) ? analysis.columnNames : [];
    const domainForm = analysis.domainForm ?? EMPTY_DOMAIN_FORM;

    const raw = await this.llmClient.requestJson({
      schemaName: 'pipeline_addon_recommendations',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                addon_id: { type: 'string' },
                tier: { type: 'string' },
                reason: { type: 'string' },
                condition: { type: 'string' },
              },
              required: ['addon_id', 'tier', 'reason', 'condition'],
            },
          },
        },
        required: ['items'],
      },
      systemPrompt: [
        'You recommend optional pipeline addon modules for an ML workbench.',
        'Use Korean for reason and condition fields.',
        'tier must be one of: priority, recommend, optional, weak, none.',
        'Base recommendations on the dataset analysis, columns, and each addon purpose.',
        'Return exactly one item per addon_id from the catalog.',
      ].join(' '),
      userPrompt: [
        '## Dataset analysis',
        `File: ${analysis.fileName || '(unknown)'}`,
        `Columns: ${columnNames.join(', ') || '(unknown)'}`,
        `Rows (estimate): ${analysis.rowCountEstimate ?? 'unknown'}`,
        `Diagnosis: ${analysis.diagnosisSummary || '(none)'}`,
        `Industry: ${domainForm.industry || '(unknown)'}`,
        `ML task: ${domainForm.ml_task || '(unknown)'}`,
        `Data modality: ${domainForm.data_modality || '(unknown)'}`,
        `Target event: ${domainForm.target_event || '(unknown)'}`,
        '',
        '## Addon catalog',
        addonLines.join('\n'),
      ].join('\n'),
    });

    let payload: { items?: Array<Record<string, unknown>> };
    try {
      payload = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
    } catch {
      return this.ruleBasedRecommendations(addons, analysis);
    }

    const parsedById = new Map<string, AddonRecommendationItem>();
    for (const row of payload.items ?? []) {
      const addonId = String(row.addon_id ?? '').trim();
      if (!addonId) continue;
      const tier = this.normalizeTier(String(row.tier ?? ''));
      parsedById.set(addonId, {
        addonId,
        tier,
        reason: String(row.reason ?? '').trim() || '데이터 특성과 단계 목표에 맞는 보완 모듈입니다.',
        condition: String(row.condition ?? '').trim() || '해당 리스크 신호가 관측될 때',
        rank: TIER_RANK[tier],
      });
    }

    return addons.map((addon) => parsedById.get(addon.id) ?? this.fallbackItem(addon, analysis));
  }

  private ruleBasedRecommendations(
    addons: AddonCatalogItem[],
    analysis: Partial<DataSourceAnalysisResult> | null,
  ): AddonRecommendationItem[] {
    return addons.map((addon) => this.fallbackItem(addon, analysis));
  }

  private fallbackItem(
    addon: AddonCatalogItem,
    analysis: Partial<DataSourceAnalysisResult> | null,
  ): AddonRecommendationItem {
    const text = [
      analysis?.diagnosisSummary ?? '',
      analysis?.domainForm?.ml_task ?? '',
      analysis?.domainForm?.data_modality ?? '',
      ...(analysis?.columnNames ?? []),
    ].join(' ').toLowerCase();

    const rules: Array<{ pattern: RegExp; tier: AddonRecommendationTier; reason: string; condition: string }> = [
      {
        pattern: /희소|불균형|sparse|imbalance|anomaly|이상/,
        tier: 'recommend',
        reason: '진단 요약·컬럼에서 클래스 불균형·희소 신호가 보입니다.',
        condition: '이상 클래스 비율이 낮거나 라벨 편향이 의심될 때',
      },
      {
        pattern: /시계열|time|date|timestamp|결측/,
        tier: 'recommend',
        reason: '시간 축 또는 결측 관련 패턴이 데이터에 포함되어 있습니다.',
        condition: '시계열 관측 길이가 최소 창 길이 이상일 때',
      },
      {
        pattern: /누수|leak|미래|future/,
        tier: 'optional',
        reason: '예측 시점 이후 정보 혼입 가능성을 점검할 가치가 있습니다.',
        condition: '예측 시점·라벨 정의가 확정된 이후',
      },
      {
        pattern: /환자|patient|의료|medical|clinical/,
        tier: 'recommend',
        reason: '의료·환자 단위 데이터 맥락과 부가 모듈 목적이 맞닿아 있습니다.',
        condition: '환자·방문 단위 레코드가 존재할 때',
      },
    ];

    const idRules: Record<string, { tier: AddonRecommendationTier; reason: string; condition: string }> = {
      addon_dx_anomaly_sparsity_deep: {
        tier: /희소|불균형|sparse|imbalance|anomaly|이상/.test(text) ? 'priority' : 'optional',
        reason: '업로드 데이터의 클래스·이상 분포를 심화 점검합니다.',
        condition: '이상 클래스 비율이 기준 미만일 때',
      },
      addon_dx_timeseries_missing_segments: {
        tier: /시계열|time|date|timestamp/.test(text) ? 'recommend' : 'weak',
        reason: '시간 축 결측 구간을 식별해 후속 단계 품질을 높입니다.',
        condition: '시계열 컬럼이 존재할 때',
      },
      addon_dx_leakage_detection: {
        tier: /누수|leak|target|label/.test(text) ? 'recommend' : 'optional',
        reason: '타깃·입력 변수 간 시간 역전 누수를 점검합니다.',
        condition: '예측 시점이 정의된 후',
      },
      addon_dom_label_mapping_clinical: {
        tier: /의료|medical|patient|label/.test(text) ? 'recommend' : 'optional',
        reason: '라벨 정의를 도메인 맥락에 맞게 구체화합니다.',
        condition: '라벨·결과 변수가 존재할 때',
      },
      addon_search_query_expansion: {
        tier: analysis?.collectionQuery ? 'recommend' : 'optional',
        reason: 'LLM이 제안한 탐색 쿼리를 확장·정교화합니다.',
        condition: '외부 데이터 탐색 단계에서',
      },
    };

    const specific = idRules[addon.id];
    if (specific) {
      return { addonId: addon.id, ...specific, rank: TIER_RANK[specific.tier] };
    }

    for (const rule of rules) {
      if (rule.pattern.test(text) || rule.pattern.test(addon.id)) {
        return {
          addonId: addon.id,
          tier: rule.tier,
          reason: rule.reason,
          condition: rule.condition,
          rank: TIER_RANK[rule.tier],
        };
      }
    }

    const tier: AddonRecommendationTier = 'weak';
    return {
      addonId: addon.id,
      tier,
      reason: '현재 데이터 메타만으로는 강한 신호가 없어 참고 등급으로 제안합니다.',
      condition: '단계 목표와 데이터가 더 명확해진 후 재검토',
      rank: TIER_RANK[tier],
    };
  }

  private normalizeTier(value: string): AddonRecommendationTier {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'priority' || normalized === '최우선') return 'priority';
    if (normalized === 'recommend' || normalized === '추천') return 'recommend';
    if (normalized === 'optional' || normalized === '검토') return 'optional';
    if (normalized === 'weak' || normalized === '참고') return 'weak';
    return 'none';
  }
}
