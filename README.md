# Backend

This backend is a Nest.js server for the stage-1 pipeline only.

Scope:

- session creation
- CSV upload
- dataset profiling
- rule-based domain recommendation
- discovery job creation and polling

Not included:

- consistency review
- synthetic generation
- validation/model benchmarking
- local LLM dependency

The current implementation assumes no local LLM is available. Domain recommendation,
keyword expansion, and discovery query generation are all rule-based so the API can run
immediately from the terminal.

## Install

```bash
cd backend
npm install
```

## Run

```bash
npm run start:dev
```

Default URL:

- `http://127.0.0.1:8787`

If you want file watching from the terminal:

```bash
npm run start:watch
```

## Terminal Smoke Test

This does not depend on the frontend.

```bash
cd backend
npm run smoke
```

The smoke test boots the Nest app on a random local port, uploads a small CSV, runs
analysis, requests domain recommendation, creates a discovery job, polls it to completion,
and prints a short JSON summary.

## API

- `GET /api/v1/health`
- `POST /api/v1/sessions`
- `POST /api/v1/datasets/upload`
- `POST /api/v1/datasets/:datasetId/analyze`
- `POST /api/v1/domains/recommend`
- `POST /api/v1/discovery/jobs`
- `GET /api/v1/discovery/jobs/:jobId`
- `GET /api/v1/discovery/jobs/:jobId/results`

## Notes

- Uploaded CSV files are stored under `backend/storage/uploads`.
- Discovery is implemented as a background in-memory job with polling.
- External discovery is currently backed by replaceable catalog connectors, not an LLM.

## Docs

- `backend/docs/README.md`
- `backend/docs/api-reference.md`
- `backend/docs/pipeline-flow.md`
- `backend/docs/local-llm.md`
