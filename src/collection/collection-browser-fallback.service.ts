import { Injectable } from '@nestjs/common';
import { nowIso } from '../common/time';
import { buildUserAgent, collapseWhitespace, envFlag, envNumber, stripHtml } from './connectors/connector.utils';
import type { FetchedDocument } from './types/collection-hit';
import {
  CollectionHtmlExtractionService,
  type CollectionExtractedHtmlMetadata,
} from './collection-html-extraction.service';

type BrowserCapture = {
  finalUrl: string;
  html: string;
  text: string;
};

@Injectable()
export class CollectionBrowserFallbackService {
  private readonly enabled = envFlag('COLLECTION_BROWSER_FALLBACK_ENABLED', false);
  private readonly strictFailure = envFlag('COLLECTION_BROWSER_FALLBACK_STRICT', false);
  private readonly timeoutMs = Math.max(
    5000,
    Math.min(envNumber('COLLECTION_BROWSER_FALLBACK_TIMEOUT_MS', 15000), 45000),
  );
  private readonly waitAfterLoadMs = Math.max(
    0,
    Math.min(envNumber('COLLECTION_BROWSER_FALLBACK_WAIT_AFTER_LOAD_MS', 600), 5000),
  );
  private readonly preferredEngine = this.normalizeEngine(
    process.env.COLLECTION_BROWSER_FALLBACK_ENGINE ?? 'auto',
  );

  constructor(private readonly htmlExtractionService: CollectionHtmlExtractionService) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  isStrictFailure(): boolean {
    return this.strictFailure;
  }

  async fetchDocument(
    sourceHitId: string,
    url: string,
  ): Promise<{ document: FetchedDocument; metadata: CollectionExtractedHtmlMetadata } | null> {
    if (!this.enabled || !url?.trim()) {
      return null;
    }

    try {
      const capture = await this.captureWithAvailableEngine(url);
      if (!capture) {
        const message = 'Browser fallback is enabled but no browser engine is available (playwright/puppeteer).';
        if (this.strictFailure) {
          throw new Error(message);
        }
        console.warn(`[CollectionBrowserFallbackService] ${message}`);
        return null;
      }

      const metadata = this.htmlExtractionService.extractHtmlMetadata(capture.html, capture.finalUrl || url);
      return {
        document: {
          sourceHitId,
          url,
          finalUrl: capture.finalUrl || url,
          extractedText: collapseWhitespace(capture.text || stripHtml(capture.html)).slice(0, 4000),
          metadata,
          extractionMethod: 'browser',
          retrievedAt: nowIso(),
        },
        metadata,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.strictFailure) {
        throw new Error(`Browser fallback fetch failed: ${message}`);
      }
      console.warn(`[CollectionBrowserFallbackService] browser fallback soft-failed: ${message}`);
      return null;
    }
  }

  private async captureWithAvailableEngine(url: string): Promise<BrowserCapture | null> {
    const engineOrder =
      this.preferredEngine === 'playwright'
        ? ['playwright', 'puppeteer']
        : this.preferredEngine === 'puppeteer'
          ? ['puppeteer', 'playwright']
          : ['playwright', 'puppeteer'];

    for (const engine of engineOrder) {
      const capture = engine === 'playwright'
        ? await this.captureWithPlaywright(url)
        : await this.captureWithPuppeteer(url);
      if (capture) {
        return capture;
      }
    }
    return null;
  }

  private async captureWithPlaywright(url: string): Promise<BrowserCapture | null> {
    let playwrightModule: unknown;
    try {
      playwrightModule = await this.dynamicImportModule('playwright');
    } catch {
      return null;
    }

    const chromium = (playwrightModule as { chromium?: { launch?: (input: Record<string, unknown>) => Promise<unknown> } })
      .chromium;
    if (!chromium?.launch) {
      return null;
    }

    let browser: {
      close: () => Promise<void>;
      newContext: (input: Record<string, unknown>) => Promise<{
        close: () => Promise<void>;
        newPage: () => Promise<{
          goto: (target: string, options: Record<string, unknown>) => Promise<unknown>;
          waitForTimeout: (ms: number) => Promise<void>;
          content: () => Promise<string>;
          evaluate: <T>(fn: () => T) => Promise<T>;
          url: () => string;
        }>;
      }>;
    } | null = null;
    let context: {
      close: () => Promise<void>;
      newPage: () => Promise<{
        goto: (target: string, options: Record<string, unknown>) => Promise<unknown>;
        waitForTimeout: (ms: number) => Promise<void>;
        content: () => Promise<string>;
        evaluate: <T>(fn: () => T) => Promise<T>;
        url: () => string;
      }>;
    } | null = null;
    try {
      browser = (await chromium.launch({
        headless: true,
      })) as {
        close: () => Promise<void>;
        newContext: (input: Record<string, unknown>) => Promise<{
          close: () => Promise<void>;
          newPage: () => Promise<{
            goto: (target: string, options: Record<string, unknown>) => Promise<unknown>;
            waitForTimeout: (ms: number) => Promise<void>;
            content: () => Promise<string>;
            evaluate: <T>(fn: () => T) => Promise<T>;
            url: () => string;
          }>;
        }>;
      };
      context = await browser.newContext({
        userAgent: buildUserAgent(),
      });
      const page = await context.newPage();
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });
      if (this.waitAfterLoadMs > 0) {
        await page.waitForTimeout(this.waitAfterLoadMs);
      }
      return {
        finalUrl: page.url(),
        html: await page.content(),
        text: await page.evaluate(() => document.body?.innerText ?? ''),
      };
    } catch {
      return null;
    } finally {
      await this.safeClose(context);
      await this.safeClose(browser);
    }
  }

  private async captureWithPuppeteer(url: string): Promise<BrowserCapture | null> {
    let puppeteerModule: unknown;
    try {
      puppeteerModule = await this.dynamicImportModule('puppeteer');
    } catch {
      return null;
    }

    const launch = (puppeteerModule as { launch?: (options: Record<string, unknown>) => Promise<unknown> }).launch;
    if (!launch) {
      return null;
    }

    let browser: {
      close: () => Promise<void>;
      newPage: () => Promise<{
        setUserAgent: (userAgent: string) => Promise<void>;
        goto: (target: string, options: Record<string, unknown>) => Promise<unknown>;
        waitForTimeout?: (ms: number) => Promise<void>;
        content: () => Promise<string>;
        evaluate: <T>(fn: () => T) => Promise<T>;
        url: () => string;
      }>;
    } | null = null;
    try {
      browser = (await launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })) as {
        close: () => Promise<void>;
        newPage: () => Promise<{
          setUserAgent: (userAgent: string) => Promise<void>;
          goto: (target: string, options: Record<string, unknown>) => Promise<unknown>;
          waitForTimeout?: (ms: number) => Promise<void>;
          content: () => Promise<string>;
          evaluate: <T>(fn: () => T) => Promise<T>;
          url: () => string;
        }>;
      };
      const page = await browser.newPage();
      await page.setUserAgent(buildUserAgent());
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });
      if (this.waitAfterLoadMs > 0 && page.waitForTimeout) {
        await page.waitForTimeout(this.waitAfterLoadMs);
      }
      return {
        finalUrl: page.url(),
        html: await page.content(),
        text: await page.evaluate(() => document.body?.innerText ?? ''),
      };
    } catch {
      return null;
    } finally {
      await this.safeClose(browser);
    }
  }

  private normalizeEngine(value: string): 'auto' | 'playwright' | 'puppeteer' {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'playwright' || normalized === 'puppeteer') {
      return normalized;
    }
    return 'auto';
  }

  private async safeClose(target: { close: () => Promise<void> } | null) {
    if (!target) {
      return;
    }
    try {
      await target.close();
    } catch {
      // ignore close failures
    }
  }

  private async dynamicImportModule(moduleName: string): Promise<unknown> {
    const importer = new Function('modulePath', 'return import(modulePath);') as (modulePath: string) => Promise<unknown>;
    return importer(moduleName);
  }
}
