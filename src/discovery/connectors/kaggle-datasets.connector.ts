import { Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { tokenize, uniqueKeepOrder } from '../../common/text';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  connectorSearchMetadata,
  envNumber,
} from './connector.utils';
import { datasetQueriesForSource, type DiscoveryPlan } from '../types/discovery-plan';
import type {
  DatasetDiscoveryHit,
  DiscoverySearchOutcome,
  KnowledgeDiscoveryHit,
} from '../types/discovery-hit';

const execFile = promisify(execFileCallback);

type KaggleRow = Record<string, string>;

@Injectable()
export class KaggleDatasetsConnector implements DiscoveryConnector {
  async searchKnowledgeHits(
    _plan: DiscoveryPlan,
    _context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<KnowledgeDiscoveryHit>> {
    return {
      hits: [],
      debug: [],
    };
  }

  async searchDatasetHits(
    plan: DiscoveryPlan,
    context: DiscoveryContext,
  ): Promise<DiscoverySearchOutcome<DatasetDiscoveryHit>> {
    const connectorMeta = connectorSearchMetadata('kaggle');
    const preflightError = this.validateEnvironment();
    if (preflightError) {
      return {
        hits: [],
        debug: [
          {
            id: '__kaggle_preflight__',
            connector: 'kaggle',
            matchedQueries: [],
            matchedTerms: [],
            status: 'error',
            error: preflightError,
          },
        ],
      };
    }
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const sourceQueries = datasetQueriesForSource(plan, 'kaggle');
    const queries = sourceQueries.slice(0, 2);

    for (const query of queries) {
      try {
        const rows = await this.listDatasets(query);
        let count = 0;
        for (const row of rows) {
          const ref = this.pick(row, ['ref', 'datasetRef']);
          const title = this.pick(row, ['title', 'subtitle', 'ref']);
          if (!ref || !title) {
            continue;
          }

          const entry = buildDatasetEntry({
            id: `kaggle:${ref}`,
            name: title,
            provider: 'Kaggle',
            providerDetail: this.providerDetail(ref, row),
            publisher: this.ownerLabel(ref),
            description: this.description(title, query, row),
            rowsHint: this.rowsHint(row),
            modality: this.inferModalityLabel(title, row),
            licenseHint: this.pick(row, ['licenseName', 'license']) || 'See Kaggle dataset page',
            sourceUrl: `https://www.kaggle.com/datasets/${ref}`,
            retrievalHint: `Matched Kaggle query: ${query}${this.popularitySuffix(row)}`,
            tags: this.tags(query, ref, title, row),
          });
          const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.providerDetail ?? ''} ${entry.modality}`;
          const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
            text,
            entry.tags,
            sourceQueries,
            plan.mustInclude,
          );

          hits.push({
            id: entry.id,
            kind: 'dataset',
            connector: 'kaggle',
            sourceType: connectorMeta.sourceType,
            sourcePriority: connectorMeta.priority,
            sourceReliability: connectorMeta.reliability,
            title: entry.name,
            text,
            tags: entry.tags,
            domainIds: entry.domainIds ?? [],
            taskSignals: entry.taskSignals ?? [],
            modalitySignals: entry.modalitySignals ?? [],
            modality: entry.modalityType ?? (context.modality === 'text' ? 'text' : 'table'),
            negativeTags: entry.negativeTags ?? [],
            matchedQueries,
            matchedTerms,
            entry,
          });
          count += 1;
        }

        debug.push({
          id: query,
          connector: 'kaggle',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'ok',
          count,
        });
      } catch (error) {
        debug.push({
          id: query,
          connector: 'kaggle',
          matchedQueries: [query],
          matchedTerms: [],
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { hits, debug };
  }

  private async listDatasets(query: string): Promise<KaggleRow[]> {
    const cliPath = process.env.KAGGLE_CLI_PATH?.trim() || 'kaggle';
    const limit = Math.max(2, Math.min(envNumber('DISCOVERY_CONNECTOR_LIMIT_PER_SOURCE', 10), 10));
    const env = {
      ...process.env,
    };

    const { stdout } = await execFile(cliPath, ['datasets', 'list', '-s', query, '--csv'], {
      env,
      timeout: envNumber('DISCOVERY_HTTP_TIMEOUT_MS', 8000),
      maxBuffer: 2 * 1024 * 1024,
    });

    const parsed = Papa.parse<KaggleRow>(stdout, {
      header: true,
      skipEmptyLines: true,
    });

    const blockingErrors = parsed.errors.filter((error) => {
      const message = error.message?.trim() ?? '';
      return !message.includes("Unable to auto-detect delimiting character");
    });
    if (blockingErrors.length > 0) {
      throw new Error(`Kaggle CSV parse failed: ${blockingErrors[0]?.message ?? 'unknown parse error'}`);
    }

    return parsed.data.slice(0, limit);
  }

  private validateEnvironment(): string | null {
    const cliPath = process.env.KAGGLE_CLI_PATH?.trim();
    if (cliPath && cliPath.includes('/') && !existsSync(cliPath)) {
      return `Kaggle CLI was not found at ${cliPath}`;
    }

    const hasToken = Boolean(process.env.KAGGLE_API_TOKEN?.trim());
    const hasLegacyPair = Boolean(process.env.KAGGLE_USERNAME?.trim() && process.env.KAGGLE_KEY?.trim());
    const configDir = process.env.KAGGLE_CONFIG_DIR?.trim();
    const hasConfigJson = Boolean(configDir && existsSync(`${configDir}/kaggle.json`));
    if (!hasToken && !hasLegacyPair && !hasConfigJson) {
      return 'Kaggle credentials are not configured.';
    }

    return null;
  }

  private pick(row: KaggleRow, keys: string[]): string {
    for (const key of keys) {
      const direct = row[key];
      if (direct && direct.trim()) {
        return direct.trim();
      }
      const normalized = Object.entries(row).find(
        ([entryKey, value]) => entryKey.toLowerCase() === key.toLowerCase() && value?.trim(),
      );
      if (normalized?.[1]?.trim()) {
        return normalized[1].trim();
      }
    }
    return '';
  }

  private inferModalityLabel(title: string, row: KaggleRow): string {
    const text = `${title} ${Object.values(row).join(' ')}`.toLowerCase();
    if (text.includes('text') || text.includes('nlp') || text.includes('prompt') || text.includes('corpus')) {
      return 'text corpus';
    }
    if (text.includes('time series') || text.includes('stock') || text.includes('ohlcv')) {
      return 'time series';
    }
    return 'dataset';
  }

  private ownerLabel(ref: string): string {
    const [owner] = ref.split('/');
    return owner || 'Kaggle publisher';
  }

  private providerDetail(ref: string, row: KaggleRow): string {
    return [
      ref,
      this.metricLabel('downloads', this.pick(row, ['downloadCount'])),
      this.metricLabel('votes', this.pick(row, ['voteCount'])),
      this.metricLabel('usability', this.pick(row, ['usabilityRating'])),
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private rowsHint(row: KaggleRow): string {
    const size = this.pick(row, ['size']);
    const files = this.pick(row, ['files', 'fileCount']);
    return [size ? `Size ${size}` : '', files ? `Files ${files}` : 'See Kaggle dataset page']
      .filter(Boolean)
      .join(' | ');
  }

  private description(title: string, query: string, row: KaggleRow): string {
    const subtitle = this.pick(row, ['subtitle']);
    const popularity = this.popularitySuffix(row);
    return subtitle || `${title}. Kaggle dataset matched for "${query}"${popularity}.`;
  }

  private popularitySuffix(row: KaggleRow): string {
    const downloads = this.pick(row, ['downloadCount']);
    const votes = this.pick(row, ['voteCount']);
    const usability = this.pick(row, ['usabilityRating']);
    const parts = [
      downloads ? `${downloads} downloads` : '',
      votes ? `${votes} votes` : '',
      usability ? `usability ${usability}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }

  private metricLabel(label: string, value: string): string {
    return value ? `${label}=${value}` : '';
  }

  private tags(query: string, ref: string, title: string, row: KaggleRow): string[] {
    return uniqueKeepOrder([
      query,
      ref,
      title,
      this.ownerLabel(ref),
      ...tokenize(ref),
      ...tokenize(title),
      ...tokenize(query),
      ...tokenize(this.pick(row, ['subtitle'])),
    ]).slice(0, 24);
  }
}
