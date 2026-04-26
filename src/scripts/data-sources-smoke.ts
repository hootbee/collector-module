import { createApp } from '../main';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function main() {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  try {
    const pipeline = await requestJson<{ pipeline: { id: string } }>(
      `${baseUrl}/api/v1/pipeline-templates/tpl-collection-first/copy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Data source smoke pipeline' }),
      },
    );

    const created = await requestJson<{ dataSource: { id: string } }>(
      `${baseUrl}/api/v1/data-sources`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'ICU vital stream',
          source: 'EMR demo',
          rowsLabel: '30k rows',
          linkedPipelineId: pipeline.pipeline.id,
          domainIndustryContext: 'Healthcare smoke test',
          dataModality: '테이블',
          rowUnit: '환자 방문',
          sensitivityNote: 'PHI-like demo metadata',
        }),
      },
    );

    const updated = await requestJson(
      `${baseUrl}/api/v1/data-sources/${created.dataSource.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowsLabel: '31k rows', domainSubjectScope: 'Adult ICU visits' }),
      },
    );
    const unlinked = await requestJson(
      `${baseUrl}/api/v1/data-sources/${created.dataSource.id}/linked-pipeline`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedPipelineId: null }),
      },
    );
    const list = await requestJson(`${baseUrl}/api/v1/data-sources`);
    const deleted = await requestJson(
      `${baseUrl}/api/v1/data-sources/${created.dataSource.id}`,
      { method: 'DELETE' },
    );

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      pipeline,
      created,
      updated,
      unlinked,
      list,
      deleted,
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
