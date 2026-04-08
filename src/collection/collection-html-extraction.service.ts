import { Injectable } from '@nestjs/common';
import { nowIso } from '../common/time';
import type { CollectionExtractionMethod } from '../common/contracts';
import { collapseWhitespace, fetchText, stripHtml } from './connectors/connector.utils';
import type { FetchedDocument } from './types/collection-hit';

export type CollectionExtractedHtmlMetadata = {
  title?: string;
  description?: string;
  publisher?: string;
  licenseHint?: string;
  directDownloadAvailable: boolean;
  linkCandidates: string[];
  downloadUrl?: string;
};

@Injectable()
export class CollectionHtmlExtractionService {
  async fetchDocument(
    sourceHitId: string,
    url: string,
    extractionMethod: CollectionExtractionMethod = 'html',
  ): Promise<{ document: FetchedDocument; metadata: CollectionExtractedHtmlMetadata } | null> {
    try {
      const html = await fetchText(url);
      const metadata = this.extractHtmlMetadata(html, url);
      return {
        document: {
          sourceHitId,
          url,
          finalUrl: url,
          extractedText: collapseWhitespace(stripHtml(html)).slice(0, 4000),
          metadata,
          extractionMethod,
          retrievedAt: nowIso(),
        },
        metadata,
      };
    } catch {
      return null;
    }
  }

  extractHtmlMetadata(html: string, pageUrl: string): CollectionExtractedHtmlMetadata {
    const title =
      this.extractMetaContent(html, 'property', 'og:title') ||
      this.extractMetaContent(html, 'name', 'twitter:title') ||
      this.extractTagText(html, 'title');
    const description =
      this.extractMetaContent(html, 'name', 'description') ||
      this.extractMetaContent(html, 'property', 'og:description') ||
      collapseWhitespace(stripHtml(html)).slice(0, 320);
    const publisher =
      this.extractMetaContent(html, 'name', 'author') ||
      this.extractMetaContent(html, 'property', 'article:publisher');
    const licenseHint = this.extractLicenseHint(html);
    const linkCandidates = this.extractLinkCandidates(html, pageUrl);

    return {
      title: title ? collapseWhitespace(title).slice(0, 180) : undefined,
      description: description ? collapseWhitespace(description).slice(0, 320) : undefined,
      publisher: publisher ? collapseWhitespace(publisher).slice(0, 140) : undefined,
      licenseHint,
      directDownloadAvailable: linkCandidates.some((candidate) => this.isDirectFileUrl(candidate)),
      linkCandidates,
      downloadUrl: linkCandidates.find((candidate) => this.isDirectFileUrl(candidate)),
    };
  }

  extractDownloadCandidates(html: string, pageUrl: string): string[] {
    const matches = [...html.matchAll(/href=["']([^"']+)["']/gi)];
    const base = this.safeBaseUrl(pageUrl);
    return this.unique(
      matches
        .map((match) => this.resolveHref(match[1]?.trim() ?? '', base))
        .filter(Boolean)
        .filter((candidate) => this.isUsefulDownloadCandidate(candidate))
        .sort((left, right) => this.downloadCandidateScore(right) - this.downloadCandidateScore(left)),
    );
  }

  hostFromUrl(url?: string): string | undefined {
    if (!url) {
      return undefined;
    }
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return undefined;
    }
  }

  isDirectFileUrl(url?: string): boolean {
    if (!url) {
      return false;
    }
    return /\.(csv|tsv|json|jsonl|zip|gz|parquet|arff|xlsx?|txt)($|\?)/i.test(url);
  }

  private extractMetaContent(html: string, attribute: 'name' | 'property', value: string): string | undefined {
    const pattern = new RegExp(
      `<meta[^>]+${attribute}=["']${value}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    );
    const reversePattern = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${value}["'][^>]*>`,
      'i',
    );
    return pattern.exec(html)?.[1] || reversePattern.exec(html)?.[1] || undefined;
  }

  private extractTagText(html: string, tagName: string): string | undefined {
    const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(html);
    return match?.[1] ? stripHtml(match[1]) : undefined;
  }

  private extractLicenseHint(html: string): string | undefined {
    const text = collapseWhitespace(stripHtml(html)).toLowerCase();
    const match = text.match(/license[:\s]+([a-z0-9 .,+-]{3,80})/i);
    return match?.[1] ? collapseWhitespace(match[1]) : undefined;
  }

  private extractLinkCandidates(html: string, pageUrl: string): string[] {
    return this.extractDownloadCandidates(html, pageUrl).slice(0, 12);
  }

  private safeBaseUrl(pageUrl: string): URL | null {
    try {
      return new URL(pageUrl);
    } catch {
      return null;
    }
  }

  private resolveHref(href: string, base: URL | null): string {
    if (!href) {
      return '';
    }
    if (/^(javascript:|mailto:|tel:)/i.test(href)) {
      return '';
    }
    if (/^https?:\/\//i.test(href)) {
      return href;
    }
    if (!base) {
      return href;
    }
    try {
      return new URL(href, base).toString();
    } catch {
      return '';
    }
  }

  private isUsefulDownloadCandidate(url: string): boolean {
    const value = url.toLowerCase();
    if (!value) {
      return false;
    }
    if (
      value.endsWith('/manifest.json') ||
      value.includes('manifest.json') ||
      value.includes('/favicon') ||
      value.endsWith('/robots.txt') ||
      value.includes('/login') ||
      value.includes('/signin') ||
      value.includes('/sign-in') ||
      value.includes('/signup') ||
      value.includes('/sign-up') ||
      value.includes('/register') ||
      value.includes('/terms') ||
      value.includes('/privacy')
    ) {
      return false;
    }
    if (this.isDirectFileUrl(url)) {
      return true;
    }
    return /\/static\/public\/|\/download\/|download=|datafile|resource|\/raw\/|\/resolve\/|\/files?\//i.test(value);
  }

  private downloadCandidateScore(url: string): number {
    const value = url.toLowerCase();
    let score = 0;
    if (value.includes('/static/public/')) score += 20;
    if (value.includes('/download/')) score += 18;
    if (value.includes('download=')) score += 16;
    if (value.includes('/raw/')) score += 14;
    if (value.includes('/resolve/')) score += 13;
    if (value.endsWith('.zip') || value.includes('.zip?')) score += 12;
    if (value.endsWith('.parquet') || value.includes('.parquet?')) score += 11;
    if (value.endsWith('.csv') || value.includes('.csv?')) score += 10;
    if (value.endsWith('.arff') || value.includes('.arff?')) score += 9;
    if (value.endsWith('.tsv') || value.includes('.tsv?')) score += 8;
    if (value.endsWith('.jsonl') || value.includes('.jsonl?')) score += 7;
    if (value.endsWith('.txt') || value.includes('.txt?')) score += 6;
    if (value.endsWith('.json') || value.includes('.json?')) score += 2;
    return score;
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }
}
