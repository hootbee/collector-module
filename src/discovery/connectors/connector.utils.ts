import type {
  DatasetCatalogEntry,
  DomainCatalogEntry,
  KnowledgeCatalogEntry,
  ModalitySignal,
  TaskSignal,
} from '../../common/contracts';
import { domainCatalog, modalityCatalog, taskCatalog } from '../../common/catalog';
import { tokenize, uniqueKeepOrder } from '../../common/text';
import { connectorMetadata } from '../discovery-ranking.config';

type ModalityType = 'text' | 'table' | 'hybrid';

export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function envNumber(name: string, defaultValue: number): number {
  const raw = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

export function buildUserAgent(): string {
  const base = process.env.DISCOVERY_FETCHER_USER_AGENT?.trim() || 'stage-one-backend/0.1';
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  return mailto ? `${base} (mailto:${mailto})` : base;
}

export function connectorSearchMetadata(connector: string) {
  return connectorMetadata(connector);
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'User-Agent': buildUserAgent(),
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'User-Agent': buildUserAgent(),
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

export function buildQueryMatchSignals(
  text: string,
  tags: string[],
  queries: string[],
  mustInclude: string[],
): { matchedQueries: string[]; matchedTerms: string[] } {
  const textTokens = new Set(tokenize(text));
  const tagTokens = new Set(tokenize(tags.join(' ')));

  const matchedQueries = uniqueKeepOrder(
    queries.filter((query) => tokenize(query).some((token) => textTokens.has(token) || tagTokens.has(token))),
  ).slice(0, 5);

  const matchedTerms = uniqueKeepOrder(
    mustInclude.filter((term) => {
      const tokens = tokenize(term);
      return tokens.some((token) => textTokens.has(token) || tagTokens.has(token));
    }),
  ).slice(0, 8);

  return { matchedQueries, matchedTerms };
}

export function inferDomainIds(text: string, tags: string[]): string[] {
  const tokens = new Set(tokenize(text, tags.join(' ')));
  const ranked = domainCatalog
    .map((domain) => ({
      id: domain.id,
      score: scoreDomainTokens(domain, tokens),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (ranked.length === 0) {
    return [];
  }

  const leader = ranked[0].score;
  return ranked
    .filter((item, index) => index === 0 || item.score >= Math.max(2, leader * 0.45))
    .slice(0, 4)
    .map((item) => item.id);
}

export function inferTaskSignals(text: string, tags: string[]): TaskSignal[] {
  const tokens = new Set(tokenize(text, tags.join(' ')));
  return taskCatalog
    .map((task) => ({
      id: task.id,
      score:
        overlapCount(tokens, tokenize(task.id, (task.aliases ?? []).join(' '), (task.strongSignals ?? []).join(' '))) * 3 +
        overlapCount(tokens, tokenize((task.supportSignals ?? []).join(' '), ...(task.querySeeds ?? []))) * 1.5,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((item) => item.id);
}

export function inferModalitySignals(
  text: string,
  tags: string[],
  modality: ModalityType,
): ModalitySignal[] {
  const tokens = new Set(tokenize(text, tags.join(' ')));
  const explicit: ModalitySignal[] =
    modality === 'text'
      ? ['text', 'document']
      : modality === 'hybrid'
        ? ['tabular', 'text']
        : ['tabular'];

  return uniqueKeepOrder([
    ...explicit,
    ...modalityCatalog
      .filter(
        (entry) =>
          overlapCount(tokens, tokenize(entry.id, (entry.aliases ?? []).join(' '), (entry.keywords ?? []).join(' '))) > 0,
      )
      .map((entry) => entry.id),
  ])
    .filter((value): value is ModalitySignal => modalityCatalog.some((entry) => entry.id === value))
    .slice(0, 3);
}

export function inferModalityType(text: string, tags: string[]): ModalityType {
  const tokens = new Set(tokenize(text, tags.join(' ')));
  const textSignals = overlapCount(tokens, [
    'text',
    'prompt',
    'content',
    'document',
    'article',
    'essay',
    'review',
    'response',
    'question',
    'corpus',
  ]);
  const tableSignals = overlapCount(tokens, [
    'csv',
    'table',
    'tabular',
    'column',
    'row',
    'dataset',
    'instances',
    'features',
    'ohlcv',
    'price',
    'transaction',
  ]);

  if (textSignals >= 3 && tableSignals >= 2) {
    return 'hybrid';
  }
  if (textSignals >= 2) {
    return 'text';
  }
  return 'table';
}

export function truncateText(value: string, limit = 320): string {
  const normalized = collapseWhitespace(stripHtml(value));
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildKnowledgeEntry(input: {
  id: string;
  title: string;
  source: string;
  summary: string;
  sourceUrl?: string;
  publisher?: string;
  retrievalHint?: string;
  tags: string[];
  kind?: KnowledgeCatalogEntry['kind'];
  domainIds?: string[];
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  modality?: ModalityType;
  negativeTags?: string[];
}): KnowledgeCatalogEntry {
  const text = `${input.title} ${input.summary} ${input.source} ${input.publisher ?? ''}`;
  const tags = uniqueKeepOrder(input.tags.map((tag) => collapseWhitespace(tag)).filter(Boolean));
  const modality = input.modality ?? inferModalityType(text, tags);
  return {
    id: input.id,
    title: input.title,
    source: input.source,
    summary: truncateText(input.summary, 280),
    kind: input.kind ?? inferKnowledgeKind(text, tags, input.sourceUrl),
    tags,
    domainIds: input.domainIds ?? inferDomainIds(text, tags),
    sourceUrl: input.sourceUrl,
    publisher: input.publisher,
    retrievalHint: input.retrievalHint,
    modality,
    taskSignals: input.taskSignals ?? inferTaskSignals(text, tags),
    modalitySignals: input.modalitySignals ?? inferModalitySignals(text, tags, modality),
    negativeTags: input.negativeTags ?? [],
  };
}

export function buildDatasetEntry(input: {
  id: string;
  name: string;
  provider: string;
  description: string;
  rowsHint?: string;
  modality?: string;
  licenseHint?: string;
  tags: string[];
  sourceUrl?: string;
  providerDetail?: string;
  publisher?: string;
  retrievalHint?: string;
  domainIds?: string[];
  taskSignals?: TaskSignal[];
  modalitySignals?: ModalitySignal[];
  modalityType?: ModalityType;
  negativeTags?: string[];
}): DatasetCatalogEntry {
  const text = `${input.name} ${input.description} ${input.provider} ${input.providerDetail ?? ''} ${input.modality ?? ''}`;
  const tags = uniqueKeepOrder(input.tags.map((tag) => collapseWhitespace(tag)).filter(Boolean));
  const modalityType = input.modalityType ?? inferModalityType(text, tags);
  return {
    id: input.id,
    name: input.name,
    provider: input.provider,
    description: truncateText(input.description, 320),
    rowsHint: input.rowsHint?.trim() || 'Unknown',
    modality: input.modality?.trim() || modalityType,
    licenseHint: input.licenseHint?.trim() || 'See source page',
    tags,
    domainIds: input.domainIds ?? inferDomainIds(text, tags),
    sourceUrl: input.sourceUrl,
    providerDetail: input.providerDetail,
    publisher: input.publisher,
    retrievalHint: input.retrievalHint,
    modalityType,
    taskSignals: input.taskSignals ?? inferTaskSignals(text, tags),
    modalitySignals: input.modalitySignals ?? inferModalitySignals(text, tags, modalityType),
    negativeTags: input.negativeTags ?? [],
  };
}

function scoreDomainTokens(domain: DomainCatalogEntry, tokens: Set<string>): number {
  const strong = overlapCount(tokens, tokenize((domain.strongSignals ?? []).join(' '), ...(domain.aliases ?? [])));
  const support = overlapCount(
    tokens,
    tokenize(domain.title, domain.shortDescription, domain.keywords.join(' '), (domain.supportSignals ?? []).join(' ')),
  );
  const negative = overlapCount(tokens, tokenize((domain.negativeSignals ?? []).join(' ')));
  return strong * 3.5 + support * 1.4 - negative * 1.8;
}

function overlapCount(tokens: Set<string>, candidates: Iterable<string>): number {
  let count = 0;
  for (const token of candidates) {
    if (tokens.has(token)) {
      count += 1;
    }
  }
  return count;
}

function inferKnowledgeKind(
  text: string,
  tags: string[],
  sourceUrl?: string,
): KnowledgeCatalogEntry['kind'] {
  const tokens = new Set(tokenize(text, tags.join(' '), sourceUrl ?? ''));
  if (tokens.has('guideline') || tokens.has('standard') || tokens.has('specification')) {
    return 'guideline';
  }
  if (tokens.has('wikipedia') || tokens.has('wiki')) {
    return 'wiki';
  }
  if (tokens.has('paper') || tokens.has('doi') || tokens.has('arxiv') || tokens.has('crossref')) {
    return 'paper';
  }
  return 'paper';
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = envNumber('DISCOVERY_HTTP_TIMEOUT_MS', 8000);
  const retryCount = Math.max(0, Math.min(envNumber('DISCOVERY_HTTP_RETRY_COUNT', 2), 3));
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.status >= 500 && attempt < retryCount) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`));
}
