import { createApp } from '../main';

async function waitForTerminalJob(baseUrl: string, jobId: string) {
  const attempts = Number(process.env.ORCHESTRATOR_SMOKE_WAIT_ATTEMPTS ?? 120);
  const waitMs = Number(process.env.ORCHESTRATOR_SMOKE_WAIT_MS ?? 1000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/orchestrator/jobs/${jobId}`);
    if (!response.ok) {
      throw new Error(`status failed: HTTP ${response.status} ${await response.text()}`);
    }
    const status = await response.json() as { status: string };
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`orchestrator job ${jobId} did not finish before timeout.`);
}

async function main() {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  const query = process.env.ORCHESTRATOR_SMOKE_QUERY?.trim() || 'air quality dataset';

  try {
    const modulesResponse = await fetch(`${baseUrl}/api/v1/orchestrator/modules`);
    if (!modulesResponse.ok) {
      throw new Error(`modules failed: HTTP ${modulesResponse.status} ${await modulesResponse.text()}`);
    }
    const modules = await modulesResponse.json();

    const createResponse = await fetch(`${baseUrl}/api/v1/orchestrator/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleType: 'collection',
        input: {
          query,
          kind: 'both',
          sources: ['seed-catalog'],
          taskSignals: ['classification'],
          modalitySignals: ['tabular'],
        },
      }),
    });
    if (!createResponse.ok) {
      throw new Error(`create failed: HTTP ${createResponse.status} ${await createResponse.text()}`);
    }
    const created = await createResponse.json() as { jobId: string };
    const finalStatus = await waitForTerminalJob(baseUrl, created.jobId);

    const resultsResponse = await fetch(`${baseUrl}/api/v1/orchestrator/jobs/${created.jobId}/results`);
    if (!resultsResponse.ok) {
      throw new Error(`results failed: HTTP ${resultsResponse.status} ${await resultsResponse.text()}`);
    }

    const logsResponse = await fetch(`${baseUrl}/api/v1/orchestrator/jobs/${created.jobId}/logs`);
    if (!logsResponse.ok) {
      throw new Error(`logs failed: HTTP ${logsResponse.status} ${await logsResponse.text()}`);
    }

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl,
      modules,
      created,
      finalStatus,
      results: await resultsResponse.json(),
      logs: await logsResponse.json(),
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
