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
    const templates = await requestJson<{ templates: Array<{ id: string }> }>(
      `${baseUrl}/api/v1/pipeline-templates`,
    );
    const templateId = templates.templates[0]?.id;
    if (!templateId) {
      throw new Error('No shared pipeline templates were returned.');
    }

    const copied = await requestJson<{ pipeline: { id: string; moduleIds: string[] } }>(
      `${baseUrl}/api/v1/pipeline-templates/${templateId}/copy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Smoke copied pipeline' }),
      },
    );

    const added = await requestJson<{ pipeline: { id: string; moduleIds: string[] } }>(
      `${baseUrl}/api/v1/pipelines/${copied.pipeline.id}/modules`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moduleId: 'analysis-stub',
          afterModuleId: 'collection',
          layout: { x: 420, y: 120 },
        }),
      },
    );

    const removed = await requestJson<{ pipeline: { id: string; moduleIds: string[] } }>(
      `${baseUrl}/api/v1/pipelines/${copied.pipeline.id}/modules/analysis-stub`,
      { method: 'DELETE' },
    );

    const loaded = await requestJson<{ pipeline: { id: string; moduleIds: string[] } }>(
      `${baseUrl}/api/v1/pipelines/${copied.pipeline.id}`,
    );

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      templateCount: templates.templates.length,
      templateId,
      copied,
      added,
      removed,
      loaded,
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
