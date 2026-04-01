const tokenPattern = /[A-Za-z0-9_]+/g;

const stopwords = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'data',
  'dataset',
  'column',
  'columns',
  'table',
  'value',
  'rows',
  'task',
  'type',
  'target',
  'description',
  'file',
  'meta',
  'user',
  'csv',
]);

export function tokenize(...texts: string[]): string[] {
  const tokens: string[] = [];
  for (const text of texts) {
    for (const match of text.toLowerCase().matchAll(tokenPattern)) {
      const token = match[0].trim();
      if (token.length < 2 || stopwords.has(token)) {
        continue;
      }
      tokens.push(token);
    }
  }
  return tokens;
}

export function uniqueKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function stableHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(31, hash) + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
