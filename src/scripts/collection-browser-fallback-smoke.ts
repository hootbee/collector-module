import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../main';
import { buildDatasetEntry } from '../modules/collection/connectors/connector.utils';
import { CollectionWebRoutingService } from '../modules/collection/collection-web-routing.service';
import type { DatasetDiscoveryHit } from '../modules/collection/types/collection-hit';

function respondHtml(res: ServerResponse, html: string) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function respondCsv(res: ServerResponse, body: string) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function router(req: IncomingMessage, res: ServerResponse, port: number) {
  const url = req.url ?? '/';
  if (url === '/unknown-dataset') {
    respondHtml(
      res,
      [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        // 동적 주입: plain html extractor로는 title/link를 충분히 잡기 어려운 페이지
        `<script>
          document.addEventListener('DOMContentLoaded', function () {
            document.title = 'Dynamic Iris Dataset';
            var p = document.createElement('p');
            p.textContent = 'Dynamic dataset landing page rendered by client JS.';
            document.body.appendChild(p);
            var a = document.createElement('a');
            a.href = 'http://127.0.0.1:${port}/files/iris.csv';
            a.textContent = 'Download CSV';
            document.body.appendChild(a);
          });
        </script>`,
        '</head>',
        '<body><div id="app"></div></body>',
        '</html>',
      ].join(''),
    );
    return;
  }

  if (url === '/files/iris.csv') {
    respondCsv(
      res,
      ['sepal_length,sepal_width,petal_length,petal_width,species', '5.1,3.5,1.4,0.2,setosa'].join('\n'),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not-found');
}

async function startFixtureServer(): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    router(req, res, port);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve fixture server address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function main() {
  const fixture = await startFixtureServer();
  const app = await createApp();
  await app.init();

  try {
    const routingService = app.get(CollectionWebRoutingService);
    const sourceUrl = `${fixture.baseUrl}/unknown-dataset`;
    const seedHit: DatasetDiscoveryHit = {
      id: 'local-serp:unknown-dataset',
      kind: 'dataset',
      connector: 'serpapi',
      sourceType: 'meta',
      sourcePriority: 0.35,
      sourceReliability: 0.35,
      title: 'unknown dataset landing page',
      text: 'generic unknown source page',
      tags: ['dataset'],
      domainIds: [],
      taskSignals: ['classification'],
      modalitySignals: ['tabular'],
      modality: 'table',
      negativeTags: [],
      matchedQueries: ['iris dataset'],
      matchedTerms: ['iris', 'dataset'],
      entry: buildDatasetEntry({
        id: 'local-serp:unknown-dataset',
        name: 'unknown dataset landing page',
        provider: 'web',
        description: 'generic unknown source page',
        tags: ['dataset'],
        sourceUrl,
      }),
      directDownloadAvailable: false,
    };

    const outcome = await routingService.routeGenericDatasetHits([seedHit]);
    const hit = outcome.hits[0];

    console.log(
      JSON.stringify(
        {
          runSettings: {
            browserFallbackEnabled: process.env.COLLECTION_BROWSER_FALLBACK_ENABLED ?? 'false',
            browserFallbackStrict: process.env.COLLECTION_BROWSER_FALLBACK_STRICT ?? 'false',
            browserFallbackEngine: process.env.COLLECTION_BROWSER_FALLBACK_ENGINE ?? 'auto',
            browserFallbackTimeoutMs: process.env.COLLECTION_BROWSER_FALLBACK_TIMEOUT_MS ?? '15000',
            browserFallbackWaitAfterLoadMs:
              process.env.COLLECTION_BROWSER_FALLBACK_WAIT_AFTER_LOAD_MS ?? '600',
          },
          routedHits: outcome.routedHits,
          fetchedDocumentCount: outcome.fetchedDocuments.length,
          fetchedDocuments: outcome.fetchedDocuments.map((item) => ({
            sourceHitId: item.sourceHitId,
            url: item.url,
            finalUrl: item.finalUrl,
            extractionMethod: item.extractionMethod,
            metadata: item.metadata,
            extractedTextPreview: item.extractedText.slice(0, 180),
          })),
          routedDatasetHit: hit
            ? {
                id: hit.id,
                sourceClassification: hit.sourceClassification,
                detectedHost: hit.detectedHost,
                extractionMethod: hit.extractionMethod,
                extractionReliability: hit.extractionReliability,
                directDownloadAvailable: hit.directDownloadAvailable,
                metadataCompleteness: hit.metadataCompleteness,
                name: hit.entry.name,
                provider: hit.entry.provider,
                description: hit.entry.description,
                sourceUrl: hit.entry.sourceUrl,
                downloadUrl: hit.entry.downloadUrl,
                downloadMethod: hit.entry.downloadMethod,
                downloadHint: hit.entry.downloadHint,
                downloadReference: hit.entry.downloadReference,
              }
            : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    await fixture.close();
  }
}

void main();
