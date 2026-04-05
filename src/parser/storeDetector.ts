import { logger } from '../utils/logger';

/**
 * Store detector — identifies the store from receipt OCR text.
 *
 * Strategy:
 * 1. Check the first 5 lines of the receipt (header area) for known store patterns.
 * 2. Fall back to scanning the entire text for store keywords.
 * 3. Use fuzzy matching to handle OCR noise (e.g., "R1MI" → "RIMI").
 *
 * Latvian grocery stores are the primary targets.
 */

interface StorePattern {
  name: string;
  /** Exact substrings (case-insensitive) to match in header */
  keywords: string[];
  /** Regex patterns for fuzzy/noisy OCR matches */
  fuzzyPatterns: RegExp[];
}

const STORES: StorePattern[] = [
  {
    name: 'Rimi',
    keywords: ['rimi', 'rimi latvija', 'rimi hyper', 'rimi mini', 'rimi super'],
    fuzzyPatterns: [
      /r[i1l][m][i1l]/i,
      /r[i1l]m[i1l]\s*latv/i,
    ],
  },
  {
    name: 'Maxima',
    keywords: ['maxima', 'maxima lv', 'maxima latvija', 'maxima x', 'maxima xx', 'maxima xxx'],
    fuzzyPatterns: [
      /max[i1l]ma/i,
      /m[a4]x[i1l]m[a4]/i,
    ],
  },
  {
    name: 'Lidl',
    keywords: ['lidl', 'lidl latvija'],
    fuzzyPatterns: [
      /l[i1l]dl/i,
      /l[i1l][d0]l/i,
    ],
  },
  {
    name: 'Coop',
    keywords: ['coop', 'laats', 'coop latvija'],
    fuzzyPatterns: [
      /c[o0]{2}p/i,
      /la[a4]ts/i,
    ],
  },
  {
    name: 'Depo',
    keywords: ['depo'],
    fuzzyPatterns: [
      /d[e3]p[o0]/i,
    ],
  },
  {
    name: 'Top!',
    keywords: ['top!', 'top '],
    fuzzyPatterns: [
      /t[o0]p[!\s]/i,
    ],
  },
  {
    name: 'Mego',
    keywords: ['mego'],
    fuzzyPatterns: [
      /m[e3]g[o0]/i,
    ],
  },
  {
    name: 'Citro',
    keywords: ['citro'],
    fuzzyPatterns: [
      /c[i1l]tr[o0]/i,
    ],
  },
];

/**
 * Detect the store name from receipt OCR text.
 * Returns store name or null if unrecognized.
 */
export function detectStore(rawText: string): string | null {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const headerLines = lines.slice(0, 7).join('\n').toLowerCase();
  const fullText = rawText.toLowerCase();

  // Pass 1: Exact keyword match in header (most reliable)
  for (const store of STORES) {
    for (const kw of store.keywords) {
      if (headerLines.includes(kw)) {
        logger.debug({ store: store.name, match: 'keyword-header' }, 'Store detected');
        return store.name;
      }
    }
  }

  // Pass 2: Fuzzy pattern match in header
  for (const store of STORES) {
    for (const pat of store.fuzzyPatterns) {
      if (pat.test(headerLines)) {
        logger.debug({ store: store.name, match: 'fuzzy-header' }, 'Store detected');
        return store.name;
      }
    }
  }

  // Pass 3: Keyword match anywhere in text
  for (const store of STORES) {
    for (const kw of store.keywords) {
      if (fullText.includes(kw)) {
        logger.debug({ store: store.name, match: 'keyword-body' }, 'Store detected');
        return store.name;
      }
    }
  }

  // Pass 4: Fuzzy match anywhere
  for (const store of STORES) {
    for (const pat of store.fuzzyPatterns) {
      if (pat.test(fullText)) {
        logger.debug({ store: store.name, match: 'fuzzy-body' }, 'Store detected');
        return store.name;
      }
    }
  }

  logger.warn('Could not detect store from receipt');
  return null;
}
