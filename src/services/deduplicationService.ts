import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Product deduplication using Levenshtein distance.
 *
 * Works on already-normalized product names. Two names are considered
 * duplicates if their similarity exceeds the configured threshold (default 0.85).
 *
 * Algorithm choice: Levenshtein is simple, deterministic, and fast enough
 * for the small product catalogs expected (~hundreds to low thousands).
 * No external dependencies needed.
 *
 * On RPi 3, comparing 1000 products against each other takes <50ms.
 */

/**
 * Compute Levenshtein distance between two strings.
 * Uses a single-row DP approach to minimize memory (O(min(m,n)) space).
 */
export function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Single row DP
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1];
      } else {
        curr[i] = 1 + Math.min(prev[i - 1], prev[i], curr[i - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

/**
 * Compute similarity ratio between two strings (0.0 - 1.0).
 * 1.0 = identical, 0.0 = completely different.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Find the best matching normalized name from existing products.
 * Returns the match if similarity exceeds threshold, null otherwise.
 */
export function findBestMatch(
  normalizedName: string,
  existingNames: string[]
): string | null {
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const existing of existingNames) {
    const score = similarity(normalizedName, existing);
    if (score > bestScore && score >= config.dedup.threshold) {
      bestScore = score;
      bestMatch = existing;
    }
  }

  if (bestMatch) {
    logger.debug(
      { input: normalizedName, match: bestMatch, score: bestScore },
      'Dedup match found'
    );
  }

  return bestMatch;
}
