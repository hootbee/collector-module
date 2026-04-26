import { createApp } from '../main';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function waitForCollection(baseUrl: string, jobId: string) {
  const maxAttempts = 120;
  const waitMs = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await requestJson<{ status: string }>(`${baseUrl}/api/v1/collection/jobs/${jobId}`);
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`Collection job ${jobId} did not complete in time.`);
}

async function main() {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  try {
    const pipeline = await requestJson<{ pipeline: { id: string } }>(`${baseUrl}/api/v1/pipelines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'module integration smoke',
        kind: 'manual',
        moduleIds: ['domain', 'search'],
        connectedAfter: ['domain'],
      }),
    });

    const domainSnapshot = await requestJson(
      `${baseUrl}/api/v1/pipelines/${pipeline.pipeline.id}/module-snapshots/domain`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: 'Domain snapshot for search integration',
          data: {
            industry: 'Healthcare',
            subdomain: 'Clinical trial safety',
            ml_task: 'Binary classification',
            target_event: 'Adverse event',
            data_modality: 'Tabular',
            row_unit: 'Patient visit',
          },
        }),
      },
    );

    const searchJob = await requestJson<{
      collectionJob: { jobId: string };
      querySource: string;
    }>(`${baseUrl}/api/v1/pipelines/${pipeline.pipeline.id}/modules/search/collection-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'air quality dataset',
        sources: ['seed-catalog'],
      }),
    });

    const finalStatus = await waitForCollection(baseUrl, searchJob.collectionJob.jobId);
    const results = await requestJson<{ datasetItems: Array<{ id: string }> }>(
      `${baseUrl}/api/v1/collection/jobs/${searchJob.collectionJob.jobId}/results`,
    );
    const selectedDatasetIds = results.datasetItems.slice(0, 2).map((item) => item.id);

    const searchSnapshot = await requestJson(
      `${baseUrl}/api/v1/pipelines/${pipeline.pipeline.id}/module-snapshots/search`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: `Selected ${selectedDatasetIds.length} datasets from collection job`,
          data: {
            collectionJobId: searchJob.collectionJob.jobId,
            selectedDatasetIds,
          },
        }),
      },
    );

    const snapshotList = await requestJson(
      `${baseUrl}/api/v1/pipelines/${pipeline.pipeline.id}/module-snapshots`,
    );
    const fetchedSearchSnapshot = await requestJson(
      `${baseUrl}/api/v1/pipelines/${pipeline.pipeline.id}/module-snapshots/search`,
    );
    const moduleCatalog = await requestJson(
      `${baseUrl}/api/v1/modules`,
    );
    const medicalModules = await requestJson(
      `${baseUrl}/api/v1/modules/domain?domainKey=medical`,
    );

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      pipeline,
      domainSnapshot,
      searchJob,
      finalStatus,
      selectedDatasetIds,
      searchSnapshot,
      snapshotList,
      fetchedSearchSnapshot,
      moduleCatalog,
      medicalModules,
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
