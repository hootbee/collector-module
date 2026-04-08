import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  CollectionDownloadItemResult,
  CollectionDownloadJobResultsResponse,
  CollectionDownloadJobStatusResponse,
  CollectionDownloadedFile,
  CollectionDownloadMethod,
  CollectionSourceId,
  ExternalDatasetItem,
} from '../common/contracts';
import { StoreService } from '../store/store.service';
import { buildUserAgent, envNumber, fetchJson, fetchText } from './connectors/connector.utils';

const execFile = promisify(execFileCallback);

type HuggingFaceDatasetInfo = {
  siblings?: Array<{ rfilename?: string }>;
};

type HuggingFaceTreeEntry = {
  path?: string;
  type?: string;
};

type OpenMlDatasetDescription = {
  id?: string;
  name?: string;
  format?: string;
  url?: string;
  parquet_url?: string;
  original_data_url?: string;
};

type OpenMlDetailResponse = {
  data_set_description?: OpenMlDatasetDescription;
};

@Injectable()
export class CollectionDownloadService {
  constructor(private readonly storeService: StoreService) {}

  async createDownloadJob(input: {
    collectionJobId: string;
    itemIds?: string[];
    targetDir?: string;
    maxFilesPerItem?: number;
  }): Promise<CollectionDownloadJobStatusResponse> {
    const collection = this.storeService.toCollectionJobResults(input.collectionJobId);
    if (!collection) {
      throw new NotFoundException(`Collection job ${input.collectionJobId} was not found.`);
    }
    if (collection.status !== 'completed') {
      throw new BadRequestException(`Collection job ${input.collectionJobId} is not completed.`);
    }
    if (collection.datasetItems.length === 0) {
      throw new BadRequestException(`Collection job ${input.collectionJobId} has no dataset items.`);
    }

    const requestedItems = this.resolveItems(collection.datasetItems, input.itemIds);
    const targetRoot = this.resolveTargetRoot(input.targetDir);
    const maxFilesPerItem = Math.max(
      1,
      Math.min(input.maxFilesPerItem ?? envNumber('COLLECTION_DOWNLOAD_MAX_FILES_PER_ITEM', 3), 10),
    );

    const job = this.storeService.createCollectionDownloadJob({
      collectionJobId: input.collectionJobId,
      requestedItemIds: requestedItems.map((item) => item.id),
      targetRoot,
      maxFilesPerItem,
    });

    void this.runJob(job.id, requestedItems, targetRoot, maxFilesPerItem);
    return this.getStatus(job.id);
  }

  getStatus(downloadJobId: string): CollectionDownloadJobStatusResponse {
    const status = this.storeService.toCollectionDownloadJobStatus(downloadJobId);
    if (!status) {
      throw new NotFoundException(`Collection download job ${downloadJobId} was not found.`);
    }
    return status;
  }

  getResults(downloadJobId: string): CollectionDownloadJobResultsResponse {
    const results = this.storeService.toCollectionDownloadJobResults(downloadJobId);
    if (!results) {
      throw new NotFoundException(`Collection download job ${downloadJobId} was not found.`);
    }
    return results;
  }

  private async runJob(
    downloadJobId: string,
    items: ExternalDatasetItem[],
    targetRoot: string,
    maxFilesPerItem: number,
  ) {
    this.storeService.startCollectionDownloadJob(downloadJobId);

    try {
      await mkdir(targetRoot, { recursive: true });
      const itemResults: CollectionDownloadItemResult[] = [];

      for (const item of items) {
        itemResults.push(await this.downloadItem(item, targetRoot, maxFilesPerItem));
      }

      this.storeService.completeCollectionDownloadJob(downloadJobId, { itemResults });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown collection download failure';
      this.storeService.failCollectionDownloadJob(downloadJobId, message);
    }
  }

  private resolveItems(
    datasetItems: ExternalDatasetItem[],
    itemIds?: string[],
  ): ExternalDatasetItem[] {
    if (!itemIds || itemIds.length === 0) {
      return [...datasetItems];
    }
    const lookup = new Set(itemIds);
    const items = datasetItems.filter((item) => lookup.has(item.id));
    if (items.length === 0) {
      throw new BadRequestException('No matching dataset items were found for the provided itemIds.');
    }
    return items;
  }

  private resolveTargetRoot(targetDir?: string): string {
    const configuredRoot =
      targetDir?.trim() ||
      process.env.COLLECTION_DOWNLOAD_STORAGE_ROOT?.trim() ||
      'storage/downloads';
    return configuredRoot.startsWith('/') ? configuredRoot : resolve(process.cwd(), configuredRoot);
  }

  private async downloadItem(
    item: ExternalDatasetItem,
    targetRoot: string,
    maxFilesPerItem: number,
  ): Promise<CollectionDownloadItemResult> {
    const itemDir = join(targetRoot, this.safeSegment(item.provider), this.safeSegment(item.id));
    await mkdir(itemDir, { recursive: true });

    try {
      const sourceId = this.resolveSourceId(item);
      let files: CollectionDownloadedFile[] = [];

      switch (sourceId) {
        case 'huggingface':
          files = await this.downloadFromHuggingFace(item, itemDir, maxFilesPerItem);
          break;
        case 'openml':
          files = await this.downloadFromOpenMl(item, itemDir);
          break;
        case 'kaggle':
          files = await this.downloadFromKaggle(item, itemDir);
          break;
        case 'uci':
          files = await this.downloadFromUci(item, itemDir);
          break;
        default:
          files = await this.downloadGeneric(item, itemDir);
          break;
      }

      return {
        itemId: item.id,
        name: item.name,
        provider: item.provider,
        status: 'completed',
        sourceUrl: item.sourceUrl,
        downloadUrl: item.downloadUrl,
        downloadMethod: item.downloadMethod,
        downloadHint: item.downloadHint,
        downloadReference: item.downloadReference,
        targetDir: itemDir,
        files,
      };
    } catch (error) {
      return {
        itemId: item.id,
        name: item.name,
        provider: item.provider,
        status: 'failed',
        sourceUrl: item.sourceUrl,
        downloadUrl: item.downloadUrl,
        downloadMethod: item.downloadMethod,
        downloadHint: item.downloadHint,
        downloadReference: item.downloadReference,
        targetDir: itemDir,
        files: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveSourceId(item: ExternalDatasetItem): CollectionSourceId | null {
    if (item.routedConnector) {
      return item.routedConnector;
    }
    if (item.detectedHost?.includes('huggingface.co')) {
      return 'huggingface';
    }
    if (item.detectedHost?.includes('openml.org')) {
      return 'openml';
    }
    if (item.detectedHost?.includes('archive.ics.uci.edu')) {
      return 'uci';
    }
    if (item.detectedHost?.includes('kaggle.com')) {
      return 'kaggle';
    }
    if (item.provider === 'Hugging Face') {
      return 'huggingface';
    }
    if (item.provider === 'OpenML') {
      return 'openml';
    }
    if (item.provider === 'Kaggle') {
      return 'kaggle';
    }
    if (item.provider === 'UCI Machine Learning Repository') {
      return 'uci';
    }
    return null;
  }

  private async downloadFromHuggingFace(
    item: ExternalDatasetItem,
    targetDir: string,
    maxFilesPerItem: number,
  ): Promise<CollectionDownloadedFile[]> {
    const repoId = item.downloadReference?.trim() || this.extractHuggingFaceRepo(item.sourceUrl);
    if (!repoId) {
      throw new Error('Hugging Face dataset reference is missing.');
    }
    const repoPath = repoId.split('/').map(encodeURIComponent).join('/');
    const infoUrl = `https://huggingface.co/api/datasets/${repoPath}`;
    const repoInfo = await fetchJson<HuggingFaceDatasetInfo>(infoUrl, {
      headers: this.hfHeaders(),
    });
    let files = (repoInfo.siblings ?? [])
      .map((entry) => entry.rfilename?.trim() ?? '')
      .filter(Boolean)
      .filter((file) => this.isDownloadableDataFile(file));

    if (files.length === 0) {
      const treeUrl = `https://huggingface.co/api/datasets/${repoPath}/tree/main?recursive=true`;
      const tree = await fetchJson<HuggingFaceTreeEntry[]>(treeUrl, {
        headers: this.hfHeaders(),
      });
      files = tree
        .map((entry) => entry.path?.trim() ?? '')
        .filter(Boolean)
        .filter((file) => this.isDownloadableDataFile(file));
    }

    if (files.length === 0) {
      throw new Error(`No downloadable data files were found for Hugging Face dataset ${repoId}.`);
    }

    const selected = this.unique(files).slice(0, maxFilesPerItem);
    const downloaded: CollectionDownloadedFile[] = [];
    for (const file of selected) {
      const encodedPath = file.split('/').map(encodeURIComponent).join('/');
      const url = `https://huggingface.co/datasets/${repoPath}/resolve/main/${encodedPath}`;
      downloaded.push(await this.downloadDirectFile(url, targetDir, basename(file)));
    }
    return downloaded;
  }

  private async downloadFromOpenMl(
    item: ExternalDatasetItem,
    targetDir: string,
  ): Promise<CollectionDownloadedFile[]> {
    const datasetId = item.downloadReference?.trim() || this.extractOpenMlId(item.sourceUrl);
    const directUrl = item.downloadUrl?.trim();

    if (directUrl && this.looksLikeDirectFile(directUrl)) {
      return [await this.downloadDirectFile(directUrl, targetDir, `${this.safeSegment(item.name)}${extname(directUrl) || '.data'}`)];
    }

    if (!datasetId) {
      throw new Error('OpenML dataset id is missing.');
    }

    const detail = await fetchJson<OpenMlDetailResponse>(`https://www.openml.org/api/v1/json/data/${datasetId}`);
    const description = detail.data_set_description;
    const candidateUrls = this.unique(
      [
        description?.parquet_url,
        description?.original_data_url,
        description?.url,
      ]
        .map((value) => value?.trim() ?? '')
        .filter(Boolean),
    );

    if (candidateUrls.length === 0) {
      throw new Error(`OpenML dataset ${datasetId} did not expose a downloadable URL.`);
    }

    const best = candidateUrls[0];
    const fallbackName = `${this.safeSegment(item.name)}${extname(best) || this.extensionFromFormat(description?.format) || '.data'}`;
    return [await this.downloadDirectFile(best, targetDir, fallbackName)];
  }

  private async downloadFromKaggle(
    item: ExternalDatasetItem,
    targetDir: string,
  ): Promise<CollectionDownloadedFile[]> {
    const reference = item.downloadReference?.trim() || this.extractKaggleReference(item.sourceUrl);
    if (!reference) {
      throw new Error('Kaggle dataset reference is missing.');
    }

    const cliPath = process.env.KAGGLE_CLI_PATH?.trim() || 'kaggle';
    await execFile(cliPath, ['datasets', 'download', '-d', reference, '-p', targetDir, '--force'], {
      env: {
        ...process.env,
      },
      timeout: envNumber('COLLECTION_DOWNLOAD_TIMEOUT_MS', 60000),
      maxBuffer: 8 * 1024 * 1024,
    });

    const files = await this.listDownloadedFiles(targetDir);
    if (files.length === 0) {
      throw new Error(`Kaggle download completed but no files were saved for ${reference}.`);
    }
    return files;
  }

  private async downloadFromUci(
    item: ExternalDatasetItem,
    targetDir: string,
  ): Promise<CollectionDownloadedFile[]> {
    const pageUrl = item.sourceUrl?.trim() || item.downloadUrl?.trim();
    if (!pageUrl) {
      throw new Error('UCI dataset page URL is missing.');
    }

    if (item.downloadUrl?.trim() && this.looksLikeDirectFile(item.downloadUrl)) {
      return [await this.downloadDirectFile(item.downloadUrl, targetDir, basename(item.downloadUrl) || `${this.safeSegment(item.name)}.zip`)];
    }

    const html = await fetchText(pageUrl);
    const candidates = this.extractDownloadCandidates(html, pageUrl);
    if (candidates.length === 0) {
      throw new Error(`No direct dataset files were found on ${pageUrl}.`);
    }

    const best = candidates[0];
    return [await this.downloadDirectFile(best, targetDir, basename(best) || `${this.safeSegment(item.name)}.zip`)];
  }

  private async downloadGeneric(
    item: ExternalDatasetItem,
    targetDir: string,
  ): Promise<CollectionDownloadedFile[]> {
    const directUrl = item.downloadUrl?.trim();
    if (directUrl && this.looksLikeDirectFile(directUrl)) {
      return [await this.downloadDirectFile(directUrl, targetDir, basename(directUrl) || `${this.safeSegment(item.name)}.bin`)];
    }

    const pageUrl = item.sourceUrl?.trim() || directUrl;
    if (!pageUrl) {
      throw new Error('No source URL is available for generic download.');
    }

    const html = await fetchText(pageUrl);
    const candidates = this.extractDownloadCandidates(html, pageUrl);
    if (candidates.length === 0) {
      throw new Error(`No direct file links were found on ${pageUrl}.`);
    }
    const best = candidates[0];
    return [await this.downloadDirectFile(best, targetDir, basename(best) || `${this.safeSegment(item.name)}.bin`)];
  }

  private async downloadDirectFile(
    url: string,
    targetDir: string,
    fallbackName: string,
  ): Promise<CollectionDownloadedFile> {
    const timeoutMs = envNumber('COLLECTION_DOWNLOAD_TIMEOUT_MS', 60000);
    const maxBytes = envNumber('COLLECTION_DOWNLOAD_MAX_BYTES', 64 * 1024 * 1024);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': buildUserAgent(),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > 0 && declaredLength > maxBytes) {
        throw new Error(`Download exceeds max size (${declaredLength} bytes > ${maxBytes} bytes).`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Downloaded file exceeds max size (${buffer.byteLength} bytes > ${maxBytes} bytes).`);
      }

      const fileName = this.resolveFileName(url, response.headers.get('content-type'), response.headers.get('content-disposition'), fallbackName);
      const path = join(targetDir, fileName);
      await mkdir(targetDir, { recursive: true });
      await writeFile(path, buffer);

      return {
        fileName,
        path,
        bytes: buffer.byteLength,
        sourceUrl: url,
        contentType: response.headers.get('content-type') ?? undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listDownloadedFiles(targetDir: string): Promise<CollectionDownloadedFile[]> {
    const names = await readdir(targetDir);
    const results: CollectionDownloadedFile[] = [];
    for (const name of names) {
      const path = join(targetDir, name);
      const info = await stat(path);
      if (!info.isFile()) {
        continue;
      }
      results.push({
        fileName: name,
        path,
        bytes: info.size,
      });
    }
    return results.sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  private extractDownloadCandidates(html: string, pageUrl: string): string[] {
    const base = new URL(pageUrl);
    const matches = [...html.matchAll(/href=["']([^"']+)["']/gi)];
    return this.unique(
      matches
        .map((match) => match[1]?.trim() ?? '')
        .filter(Boolean)
        .map((href) => {
          try {
            return new URL(href, base).toString();
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .filter((candidate) => this.isUsefulDownloadCandidate(candidate))
        .sort((left, right) => this.downloadCandidateScore(right) - this.downloadCandidateScore(left)),
    );
  }

  private resolveFileName(
    url: string,
    contentType: string | null,
    contentDisposition: string | null,
    fallbackName: string,
  ): string {
    const fromDisposition = contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
    if (fromDisposition?.trim()) {
      return this.safeFileName(decodeURIComponent(fromDisposition.trim().replace(/"/g, '')));
    }

    const fromUrl = basename(new URL(url).pathname);
    if (fromUrl && fromUrl !== '/' && extname(fromUrl)) {
      return this.safeFileName(fromUrl);
    }

    const extension = this.extensionFromContentType(contentType) || extname(fallbackName) || '.bin';
    const base = extname(fallbackName) ? fallbackName.slice(0, -extname(fallbackName).length) : fallbackName;
    return this.safeFileName(`${base}${extension}`);
  }

  private extensionFromContentType(contentType: string | null): string | undefined {
    if (!contentType) {
      return undefined;
    }
    const value = contentType.toLowerCase();
    if (value.includes('parquet')) return '.parquet';
    if (value.includes('csv')) return '.csv';
    if (value.includes('jsonl')) return '.jsonl';
    if (value.includes('json')) return '.json';
    if (value.includes('tab-separated')) return '.tsv';
    if (value.includes('zip')) return '.zip';
    if (value.includes('gzip')) return '.gz';
    if (value.includes('excel')) return '.xlsx';
    if (value.includes('plain')) return '.txt';
    if (value.includes('arff')) return '.arff';
    return undefined;
  }

  private extensionFromFormat(format?: string): string | undefined {
    const value = format?.trim().toLowerCase();
    if (!value) {
      return undefined;
    }
    if (value === 'arff') return '.arff';
    if (value === 'csv') return '.csv';
    if (value === 'json') return '.json';
    if (value === 'parquet') return '.parquet';
    return `.${value}`;
  }

  private isDownloadableDataFile(path: string): boolean {
    const value = path.toLowerCase();
    if (value.endsWith('readme.md') || value.endsWith('.gitattributes')) {
      return false;
    }
    return /\.(parquet|csv|tsv|jsonl|json|txt|zip|gz|tar|arff|xlsx?)$/i.test(value);
  }

  private looksLikeDirectFile(url: string): boolean {
    return /\.(csv|tsv|json|jsonl|zip|gz|parquet|arff|xlsx?|txt)($|\?)/i.test(url);
  }

  private isUsefulDownloadCandidate(url: string): boolean {
    const value = url.toLowerCase();
    if (value.endsWith('/manifest.json') || value.includes('manifest.json')) {
      return false;
    }
    if (value.includes('/favicon') || value.endsWith('/robots.txt')) {
      return false;
    }
    if (this.looksLikeDirectFile(url)) {
      return true;
    }
    return /\/static\/public\/|\/download\/|datafile|resource/i.test(value);
  }

  private downloadCandidateScore(url: string): number {
    const value = url.toLowerCase();
    let score = 0;
    if (value.includes('/static/public/')) score += 20;
    if (value.includes('/download/')) score += 15;
    if (value.endsWith('.zip') || value.includes('.zip?')) score += 12;
    if (value.endsWith('.parquet') || value.includes('.parquet?')) score += 11;
    if (value.endsWith('.csv') || value.includes('.csv?')) score += 10;
    if (value.endsWith('.arff') || value.includes('.arff?')) score += 9;
    if (value.endsWith('.tsv') || value.includes('.tsv?')) score += 8;
    if (value.endsWith('.jsonl') || value.includes('.jsonl?')) score += 7;
    if (value.endsWith('.json') || value.includes('.json?')) score += 2;
    return score;
  }

  private extractHuggingFaceRepo(sourceUrl?: string): string | undefined {
    if (!sourceUrl) {
      return undefined;
    }
    try {
      const url = new URL(sourceUrl);
      const match = url.pathname.match(/\/datasets\/(.+)$/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private extractOpenMlId(sourceUrl?: string): string | undefined {
    if (!sourceUrl) {
      return undefined;
    }
    try {
      const url = new URL(sourceUrl);
      const id = url.searchParams.get('id');
      if (id) {
        return id;
      }
      const match = url.pathname.match(/\/(\d+)(?:\/)?$/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private extractKaggleReference(sourceUrl?: string): string | undefined {
    if (!sourceUrl) {
      return undefined;
    }
    try {
      const url = new URL(sourceUrl);
      const match = url.pathname.match(/\/datasets\/([^/]+\/[^/]+)$/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private hfHeaders(): HeadersInit {
    const headers: HeadersInit = {};
    if (process.env.HF_TOKEN?.trim()) {
      headers.Authorization = `Bearer ${process.env.HF_TOKEN.trim()}`;
    }
    return headers;
  }

  private safeSegment(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'item';
  }

  private safeFileName(value: string): string {
    return this.safeSegment(value.replace(/\//g, '-'));
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }
}
