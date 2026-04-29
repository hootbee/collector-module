import { createApp } from '../main';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function loginAsSmokeUser(baseUrl: string): Promise<{ accessToken: string }> {
  const loginId = 'smoke-user';
  const password = 'password1234';
  const name = 'Smoke User';
  try {
    await requestJson(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, loginId, password }),
    });
  } catch {
    // already exists
  }
  return requestJson(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
}

async function main() {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  try {
    const unauthList = await requestJson<{ items: unknown[]; authRequired: boolean }>(`${baseUrl}/api/v1/data-sources`);
    if (!Array.isArray(unauthList.items) || unauthList.authRequired !== true) {
      throw new Error('unauth list response must include items[] and authRequired=true');
    }

    const auth = await loginAsSmokeUser(baseUrl);
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    };

    const pipeline = await requestJson<{ pipeline: { id: string } }>(
      `${baseUrl}/api/v1/pipeline-templates/tpl-collection-first/copy`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ title: 'Data source smoke pipeline' }),
      },
    );

    const created = await requestJson<{ dataSource: { id: string } }>(
      `${baseUrl}/api/v1/data-sources`,
      {
        method: 'POST',
        headers: authHeaders,
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
        headers: authHeaders,
        body: JSON.stringify({ rowsLabel: '31k rows', domainSubjectScope: 'Adult ICU visits' }),
      },
    );
    const unlinked = await requestJson(
      `${baseUrl}/api/v1/data-sources/${created.dataSource.id}/linked-pipeline`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ linkedPipelineId: null }),
      },
    );
    const list = await requestJson(`${baseUrl}/api/v1/data-sources`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    const deleted = await requestJson(
      `${baseUrl}/api/v1/data-sources/${created.dataSource.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    );

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      unauthList,
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
