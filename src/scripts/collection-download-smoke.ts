import { join, resolve } from 'node:path';
import { createApp } from '../main';
import type { CollectionSourceId, ExternalDatasetItem } from '../common/contracts';
import { CollectionDownloadService } from '../collection/collection-download.service';
import { CollectionService } from '../collection/collection.service';

function loadSources(): CollectionSourceId[] {
  const raw = process.env.COLLECTION_DOWNLOAD_SMOKE_SOURCES?.trim();
  if (!raw) {
    return ['huggingface'];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as CollectionSourceId[];
}

async function waitForCollectionJob(collectionService: CollectionService, jobId: string) {
  const waitAttempts = Number(process.env.COLLECTION_DOWNLOAD_SMOKE_WAIT_ATTEMPTS ?? 120);
  const waitMs = Number(process.env.COLLECTION_DOWNLOAD_SMOKE_WAIT_MS ?? 500);

  for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
    const status = collectionService.getStatus(jobId);
    if (status.status === 'failed') {
      throw new Error(`Collection job ${jobId} failed: ${status.error ?? 'unknown error'}`);
    }
    if (status.status === 'completed') {
      return collectionService.getResults(jobId);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  throw new Error(`Collection job ${jobId} did not complete in time.`);
}

async function waitForDownloadJob(downloadService: CollectionDownloadService, jobId: string) {
  const waitAttempts = Number(process.env.COLLECTION_DOWNLOAD_SMOKE_WAIT_ATTEMPTS ?? 120);
  const waitMs = Number(process.env.COLLECTION_DOWNLOAD_SMOKE_WAIT_MS ?? 500);

  for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
    const status = downloadService.getStatus(jobId);
    if (status.status === 'failed') {
      throw new Error(`Download job ${jobId} failed: ${status.error ?? 'unknown error'}`);
    }
    if (status.status === 'completed') {
      return downloadService.getResults(jobId);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  throw new Error(`Download job ${jobId} did not complete in time.`);
}

function chooseItem(items: ExternalDatasetItem[]): ExternalDatasetItem {
  const preferred = process.env.COLLECTION_DOWNLOAD_SMOKE_ITEM_MATCH?.trim().toLowerCase();
  if (!preferred) {
    return items[0];
  }
  const found = items.find((item) =>
    [item.id, item.name, item.provider, item.downloadReference ?? '', item.sourceUrl ?? '']
      .join(' ')
      .toLowerCase()
      .includes(preferred),
  );
  if (!found) {
    throw new Error(`No dataset item matched "${preferred}".`);
  }
  return found;
}

async function main() {
  const app = await createApp();
  await app.init();

  const collectionService = app.get(CollectionService);
  const downloadService = app.get(CollectionDownloadService);

  try {
    const query = process.env.COLLECTION_DOWNLOAD_SMOKE_QUERY?.trim() || 'ai generated text detection dataset';
    const sources = loadSources();
    const targetRoot = resolve(
      process.cwd(),
      process.env.COLLECTION_DOWNLOAD_SMOKE_TARGET_DIR?.trim() ||
        join('storage', 'download-smoke', `${Date.now()}`),
    );
    const maxFilesPerItem = Number(process.env.COLLECTION_DOWNLOAD_SMOKE_MAX_FILES_PER_ITEM ?? '2');

    const collectionStatus = await collectionService.createJob({
      query,
      kind: 'dataset',
      requestedSources: sources,
      taskSignals: [],
      modalitySignals: [],
      mustInclude: [],
      mustAvoid: [],
    });
    const collectionResults = await waitForCollectionJob(collectionService, collectionStatus.jobId);
    if (collectionResults.datasetItems.length === 0) {
      throw new Error('No dataset items were collected.');
    }

    const selectedItem = chooseItem(collectionResults.datasetItems);
    const downloadStatus = await downloadService.createDownloadJob({
      collectionJobId: collectionResults.jobId,
      itemIds: [selectedItem.id],
      targetDir: targetRoot,
      maxFilesPerItem,
    });
    const downloadResults = await waitForDownloadJob(downloadService, downloadStatus.downloadJobId);

    console.log(
      JSON.stringify(
        {
          runSettings: {
            query,
            sources,
            targetRoot,
            maxFilesPerItem,
            itemMatch: process.env.COLLECTION_DOWNLOAD_SMOKE_ITEM_MATCH?.trim() || null,
          },
          collectionJobId: collectionResults.jobId,
          collectionDatasetCount: collectionResults.datasetItems.length,
          selectedItem: {
            id: selectedItem.id,
            provider: selectedItem.provider,
            name: selectedItem.name,
            sourceUrl: selectedItem.sourceUrl,
            downloadUrl: selectedItem.downloadUrl,
            downloadMethod: selectedItem.downloadMethod,
            downloadHint: selectedItem.downloadHint,
            downloadReference: selectedItem.downloadReference,
          },
          downloadJobId: downloadResults.downloadJobId,
          status: downloadResults.status,
          stage: downloadResults.stage,
          itemResults: downloadResults.itemResults,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

void main();
