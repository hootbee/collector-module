import { createApp } from '../main';

type SessionResponse = {
  sessionId: string;
};

type UploadResponse = {
  datasetId: string;
};

type AnalyzeResponse = {
  metadataCandidates: string[];
  rowCount: number;
};

type RecommendationResponse = {
  recommendedDomains: Array<{ id: string; name: string }>;
};

type JobStatusResponse = {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
};

type JobResultsResponse = {
  knowledgeItems: Array<{ id: string }>;
  datasetItems: Array<{ id: string }>;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function waitForJob(baseUrl: string, jobId: string): Promise<JobResultsResponse> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await requestJson<JobStatusResponse>(`${baseUrl}/api/v1/discovery/jobs/${jobId}`);
    if (status.status === 'failed') {
      throw new Error(`Discovery job ${jobId} failed.`);
    }
    if (status.status === 'completed') {
      return requestJson<JobResultsResponse>(`${baseUrl}/api/v1/discovery/jobs/${jobId}/results`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Discovery job ${jobId} did not complete in time.`);
}

async function main() {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as { address(): { port: number } };
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const csv = [
      'patient_id,visit_date,heart_rate,alt_u_l,adverse_event_flag',
      'P001,2025-01-01,75,23,no',
      'P002,2025-01-02,92,51,yes',
      'P003,2025-01-03,88,47,no',
      'P004,2025-01-04,65,19,no',
      'P005,2025-01-05,97,62,yes',
    ].join('\n');

    const session = await requestJson<SessionResponse>(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
    });

    const form = new FormData();
    form.append('sessionId', session.sessionId);
    form.append('targetColumns', JSON.stringify(['adverse_event_flag']));
    form.append('taskType', 'classification');
    form.append('description', 'Small clinical visit table for adverse event prediction.');
    form.append('file', new File([csv], 'smoke.csv', { type: 'text/csv' }));

    const upload = await requestJson<UploadResponse>(`${baseUrl}/api/v1/datasets/upload`, {
      method: 'POST',
      body: form,
    });

    const analysis = await requestJson<AnalyzeResponse>(
      `${baseUrl}/api/v1/datasets/${upload.datasetId}/analyze`,
      { method: 'POST' },
    );

    const recommendation = await requestJson<RecommendationResponse>(
      `${baseUrl}/api/v1/domains/recommend`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          datasetId: upload.datasetId,
          metadataColumns: analysis.metadataCandidates,
        }),
      },
    );

    const job = await requestJson<JobStatusResponse>(`${baseUrl}/api/v1/discovery/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        datasetId: upload.datasetId,
        metadataColumns: analysis.metadataCandidates,
        selectedDomains: recommendation.recommendedDomains.slice(0, 2).map((item) => item.name),
      }),
    });

    const results = await waitForJob(baseUrl, job.jobId);

    console.log(
      JSON.stringify(
        {
          datasetId: upload.datasetId,
          rowCount: analysis.rowCount,
          metadataCandidates: analysis.metadataCandidates,
          topDomains: recommendation.recommendedDomains.slice(0, 3).map((item) => item.id),
          knowledgeCount: results.knowledgeItems.length,
          datasetCount: results.datasetItems.length,
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
