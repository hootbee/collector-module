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
    const unauthList = await requestJson<{ items: unknown[]; authRequired: boolean }>(`${baseUrl}/api/v1/pipelines`);
    if (!Array.isArray(unauthList.items) || unauthList.authRequired !== true) {
      throw new Error('unauth list response must include items[] and authRequired=true');
    }

    const auth = await loginAsSmokeUser(baseUrl);
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    };
    const created = await requestJson<{ pipeline: { id: string } }>(`${baseUrl}/api/v1/pipelines`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kind: 'manual',
        domainKey: 'medical',
        domainLabel: '의료',
        title: 'Pipeline CRUD smoke',
        description: 'CRUD smoke baseline',
        moduleIds: ['diagnosis', 'domain', 'search'],
        connectedAfter: ['diagnosis', 'domain'],
        moduleLayout: {
          diagnosis: { x: 100, y: 100 },
          domain: { x: 340, y: 100 },
          search: { x: 580, y: 100 },
        },
      }),
    });

    const updated = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
          title: 'Pipeline CRUD smoke updated',
          description: 'metadata patch check',
          autoNamed: false,
        }),
      },
    );

    const reordered = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/modules/reorder`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
          moduleIds: ['domain', 'diagnosis', 'search'],
        }),
      },
    );

    const moved = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/modules/diagnosis/position`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ position: { x: 420, y: 220 } }),
      },
    );

    const relinked = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/connections`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ connectedAfter: ['domain'] }),
      },
    );

    const connected = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/connections/diagnosis/connect`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    );

    const disconnected = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/connections/diagnosis`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    );

    const duplicated = await requestJson<{ pipeline: { id: string; title: string } }>(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}/duplicate`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ title: 'Pipeline CRUD smoke duplicated' }),
      },
    );

    const deleted = await requestJson(
      `${baseUrl}/api/v1/pipelines/${created.pipeline.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    );

    const list = await requestJson(`${baseUrl}/api/v1/pipelines`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      unauthList,
      created,
      updated,
      reordered,
      moved,
      relinked,
      connected,
      disconnected,
      duplicated,
      deleted,
      list,
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
