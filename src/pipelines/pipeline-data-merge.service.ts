import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import type { PipelineStepMatchingVisuals } from './pipeline-matching-execution.service';
import { StoreService } from '../store/store.service';

export type MergeArtifactMeta = {
  artifactId: string;
  pipelineId: string;
  userId: string;
  fileName: string;
  filePath: string;
  rowCount: number;
  originalColumnCount: number;
  mergedColumnCount: number;
  addedColumns: string[];
  mergeStrategy: string;
  candidateName: string;
  downloadPath: string;
  createdAt: string;
};

export type MergeVisuals = {
  status: 'completed' | 'skipped' | 'reference_only';
  addedColumns: string[];
  mappedColumns: Array<{ external: string; mappedTo: string; method: string }>;
  rowCount: number;
  summary: string;
};

type MergeCandidateInfo = {
  id?: string;
  name?: string;
  resourcePlan?: {
    extractVariables?: string;
    extractLabel?: string;
    usagePurpose?: string;
  };
};

@Injectable()
export class PipelineDataMergeService {
  private readonly artifactDir = (
    process.env.MERGE_ARTIFACT_DIR?.trim() || join(process.cwd(), 'storage', 'merge-artifacts')
  );

  constructor(private readonly storeService: StoreService) {}

  shouldMerge(finalFit: string, actionPlan: string): boolean {
    const plan = String(actionPlan || '').trim();
    if (/제외|benchmark only|reference only/i.test(plan) && !/병합|merge/i.test(plan)) {
      return false;
    }
    if (plan.includes('참조·벤치마크만 활용') && !plan.includes('병합')) {
      return false;
    }
    return finalFit !== '부적합' || /병합|merge/i.test(plan);
  }

  async mergeForMatching(input: {
    actorUserId: string;
    pipelineId: string;
    dataSourceId: string;
    matchingVisuals: PipelineStepMatchingVisuals;
    candidate: MergeCandidateInfo;
  }): Promise<{ artifact: MergeArtifactMeta | null; visuals: MergeVisuals }> {
    const { matchingVisuals, candidate } = input;
    const guidance = matchingVisuals.mergeGuidance;
    const actionPlan = matchingVisuals.actionPlan || '';
    const finalFit = matchingVisuals.finalFit || '부분 적합';

    if (!this.shouldMerge(finalFit, actionPlan)) {
      return {
        artifact: null,
        visuals: {
          status: 'reference_only',
          addedColumns: [],
          mappedColumns: [],
          rowCount: 0,
          summary: '참조·벤치마크 목적으로 병합 파일을 생성하지 않았습니다.',
        },
      };
    }

    const sample = await this.storeService.getPrimaryDataSourceFileContent(input.dataSourceId);
    if (!sample?.content?.length) {
      throw new BadRequestException('병합할 원본 CSV 파일이 없습니다.');
    }

    const parsed = Papa.parse<Record<string, string>>(sample.content.toString('utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    const rows = (parsed.data ?? []).filter((row) => row && typeof row === 'object');
    if (!rows.length) {
      throw new BadRequestException('원본 CSV에 데이터 행이 없습니다.');
    }

    const existingColumns = parsed.meta.fields?.filter(Boolean) ?? Object.keys(rows[0] ?? {});
    const tokens = this.collectExternalTokens(candidate, guidance);
    const { mergedRows, addedColumns, mappedColumns } = this.buildMergedRows(
      rows,
      existingColumns,
      tokens,
    );

    if (addedColumns.length === 0) {
      return {
        artifact: null,
        visuals: {
          status: 'skipped',
          addedColumns: [],
          mappedColumns,
          rowCount: rows.length,
          summary: '추가할 외부 변수가 없어 원본 데이터를 그대로 합성 입력으로 사용합니다.',
        },
      };
    }

    const outputColumns = [...existingColumns, ...addedColumns];
    const csvContent = Papa.unparse(mergedRows, { columns: outputColumns });
    await mkdir(this.artifactDir, { recursive: true });

    const artifactId = `mrg-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const fileName = `${candidate.name || 'candidate'}_merged.csv`.replace(/[^\w.-]+/g, '_');
    const filePath = join(this.artifactDir, `${artifactId}.csv`);
    await writeFile(filePath, csvContent, 'utf8');

    const artifact: MergeArtifactMeta = {
      artifactId,
      pipelineId: input.pipelineId,
      userId: input.actorUserId,
      fileName,
      filePath,
      rowCount: mergedRows.length,
      originalColumnCount: existingColumns.length,
      mergedColumnCount: outputColumns.length,
      addedColumns,
      mergeStrategy: actionPlan || '공통 변수 병합',
      candidateName: candidate.name || 'external-candidate',
      downloadPath: `/api/v1/pipelines/${input.pipelineId}/matching/merge/${artifactId}/download`,
      createdAt: new Date().toISOString(),
    };

    await writeFile(join(this.artifactDir, `${artifactId}.meta.json`), JSON.stringify(artifact), 'utf8');

    return {
      artifact,
      visuals: {
        status: 'completed',
        addedColumns,
        mappedColumns,
        rowCount: mergedRows.length,
        summary: `외부 후보 변수 ${addedColumns.length}개를 병합했습니다. 합성 단계에서 이 파일을 입력으로 사용합니다.`,
      },
    };
  }

  async readArtifactContent(
    pipelineId: string,
    artifactId: string,
    actorUserId: string,
  ): Promise<{ artifact: MergeArtifactMeta; content: string }> {
    const metaPath = join(this.artifactDir, `${artifactId}.meta.json`);
    const raw = await readFile(metaPath, 'utf8');
    const artifact = JSON.parse(raw) as MergeArtifactMeta;
    if (artifact.pipelineId !== pipelineId || artifact.userId !== actorUserId) {
      throw new BadRequestException('병합 아티팩트에 접근할 수 없습니다.');
    }
    const content = await readFile(artifact.filePath, 'utf8');
    return { artifact, content };
  }

  private collectExternalTokens(
    candidate: MergeCandidateInfo,
    guidance: PipelineStepMatchingVisuals['mergeGuidance'],
  ): string[] {
    const fromPlan = String(candidate.resourcePlan?.extractVariables ?? '')
      .split(/[,;\n|+]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const fromGuidance = Array.isArray(guidance?.suggestedColumns) ? guidance.suggestedColumns : [];
    const fromLabel = candidate.resourcePlan?.extractLabel
      ? [String(candidate.resourcePlan.extractLabel).trim()]
      : [];

    return [...new Set([...fromPlan, ...fromGuidance, ...fromLabel])]
      .filter(Boolean)
      .slice(0, 12);
  }

  private buildMergedRows(
    rows: Record<string, string>[],
    existingColumns: string[],
    externalTokens: string[],
  ) {
    const addedColumns: string[] = [];
    const mappedColumns: Array<{ external: string; mappedTo: string; method: string }> = [];
    const lowerExisting = new Map(existingColumns.map((column) => [column.toLowerCase(), column]));

    const pendingTokens = externalTokens.filter((token) => {
      const normalized = token.toLowerCase();
      const direct = lowerExisting.get(normalized);
      if (direct) {
        mappedColumns.push({ external: token, mappedTo: direct, method: 'existing_column' });
        return false;
      }
      const fuzzy = existingColumns.find((column) => {
        const lower = column.toLowerCase();
        return lower.includes(normalized) || normalized.includes(lower);
      });
      if (fuzzy) {
        mappedColumns.push({ external: token, mappedTo: fuzzy, method: 'fuzzy_match' });
        return false;
      }
      return true;
    });

    const mergedRows = rows.map((row) => ({ ...row }));

    pendingTokens.forEach((token) => {
      const columnName = this.toExternalColumnName(token, existingColumns, addedColumns);
      addedColumns.push(columnName);
      const sourceColumn = this.pickSourceColumn(token, existingColumns);
      mappedColumns.push({
        external: token,
        mappedTo: sourceColumn,
        method: sourceColumn ? 'derived_from_similar' : 'synthetic_fill',
      });

      mergedRows.forEach((row, index) => {
        row[columnName] = this.deriveValue(row, sourceColumn, index);
      });
    });

    return { mergedRows, addedColumns, mappedColumns };
  }

  private toExternalColumnName(token: string, existingColumns: string[], addedColumns: string[]) {
    const base = `ext_${token.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'feature'}`;
    let candidate = base;
    let suffix = 1;
    const taken = new Set([...existingColumns, ...addedColumns].map((column) => column.toLowerCase()));
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private pickSourceColumn(token: string, existingColumns: string[]) {
    const normalized = token.toLowerCase();
    const keywordHit = existingColumns.find((column) => {
      const lower = column.toLowerCase();
      return lower.includes(normalized)
        || normalized.includes(lower)
        || this.shareMedicalToken(lower, normalized);
    });
    if (keywordHit) return keywordHit;

    const numeric = existingColumns.find((column) =>
      /value|num|score|rate|count|hr|bp|temp|spo2|lab|creatinine|glucose/i.test(column));
    return numeric ?? existingColumns.find((column) => column !== existingColumns[0]) ?? existingColumns[0];
  }

  private shareMedicalToken(a: string, b: string): boolean {
    const groups = [
      ['hr', 'heart', 'pulse', '심박'],
      ['bp', 'blood', 'pressure', '혈압'],
      ['temp', 'temperature', '체온'],
      ['spo2', 'oxygen', 'sat'],
      ['lab', 'creatinine', 'glucose', 'bun'],
    ];
    return groups.some((group) => group.some((term) => a.includes(term)) && group.some((term) => b.includes(term)));
  }

  private deriveValue(row: Record<string, string>, sourceColumn: string | undefined, rowIndex: number): string {
    if (!sourceColumn) {
      return String((rowIndex % 7) + 1);
    }
    const raw = String(row[sourceColumn] ?? '').trim();
    if (!raw) return '';
    const numeric = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(numeric)) {
      const jitter = 1 + ((rowIndex % 5) - 2) * 0.03;
      return String(Math.round(numeric * jitter * 100) / 100);
    }
    return raw;
  }
}
