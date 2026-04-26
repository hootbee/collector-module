export function previewLlmText(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

export function extractJsonBlock(text: string): string | null {
  const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    const parsedCandidate = extractFirstJsonObject(candidate);
    if (parsedCandidate) {
      return parsedCandidate;
    }
  }
  return extractFirstJsonObject(text);
}

export function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth !== 0 || start < 0) {
      continue;
    }
    const candidate = text.slice(start, index + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      start = -1;
    }
  }
  return null;
}
