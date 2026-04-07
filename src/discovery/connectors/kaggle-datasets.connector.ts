import { Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiscoveryContext } from '../../common/contracts';
import type { DiscoveryConnector } from './connector.interface';
import {
  buildDatasetEntry,
  buildQueryMatchSignals,
  envNumber,
} from './connector.utils';
import type { DiscoveryPlan } from '../types/discovery-plan';
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
    const hits: DatasetDiscoveryHit[] = [];
    const debug: DiscoverySearchOutcome<DatasetDiscoveryHit>['debug'] = [];
    const queries = plan.datasetQueries.slice(0, 2);

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
            providerDetail: ref,
            description: this.pick(row, ['subtitle', 'title']) || `${title} dataset on Kaggle.`,
            rowsHint: this.pick(row, ['size', 'files', 'fileCount']) || 'See Kaggle dataset page',
            modality: this.inferModalityLabel(title, row),
            licenseHint: this.pick(row, ['licenseName', 'license']) || 'See Kaggle dataset page',
            sourceUrl: `https://www.kaggle.com/datasets/${ref}`,
            retrievalHint: `Matched Kaggle query: ${query}`,
            tags: [query, ref, title, this.pick(row, ['tags'])].filter(Boolean) as string[],
          });
          const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.providerDetail ?? ''} ${entry.modality}`;
          const { matchedQueries, matchedTerms } = buildQueryMatchSignals(
            text,
            entry.tags,
            plan.datasetQueries,
            plan.mustInclude,
          );

          hits.push({
            id: entry.id,
            kind: 'dataset',
            connector: 'kaggle',
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

    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors[0]?.message ?? 'Failed to parse Kaggle CLI CSV output.');
    }

    return parsed.data.slice(0, limit);
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
}
