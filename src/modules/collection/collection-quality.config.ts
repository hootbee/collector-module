export type CollectionQualityThresholds = {
  minCandidates: number;
  minUsableCount: number;
  minRelevanceScore: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function parseRelevanceScore(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** 외부 데이터 탐색 성공 판정 기준 (환경 변수로 조정 가능) */
export function getCollectionQualityThresholds(): CollectionQualityThresholds {
  return {
    minCandidates: parsePositiveInt(process.env.COLLECTION_MIN_CANDIDATES, 1),
    minUsableCount: parsePositiveInt(process.env.COLLECTION_MIN_USABLE_COUNT, 1),
    minRelevanceScore: parseRelevanceScore(process.env.COLLECTION_MIN_RELEVANCE_SCORE, 0),
  };
}
