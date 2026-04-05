/**
 * Product name normalizer — deterministic pipeline to create
 * canonical product names from noisy OCR output.
 *
 * Pipeline:
 * 1. Remove diacritics (BANĀNI → BANANI)
 * 2. Lowercase
 * 3. Remove measurement units (kg, g, l, ml, gab, etc.)
 * 4. Remove numeric values (weights, volumes, counts)
 * 5. Remove punctuation
 * 6. Trim and collapse whitespace
 *
 * The goal is: "PIENS 1L", "PIENS 1.0L", "PIENS 2L" all → "piens"
 */

/**
 * Latvian/common diacritics map for deterministic removal.
 * Covers characters found on Latvian receipts.
 */
const DIACRITICS: Record<string, string> = {
  'ā': 'a', 'č': 'c', 'ē': 'e', 'ģ': 'g', 'ī': 'i',
  'ķ': 'k', 'ļ': 'l', 'ņ': 'n', 'š': 's', 'ū': 'u',
  'ž': 'z', 'ö': 'o', 'ü': 'u', 'ä': 'a', 'é': 'e',
  'è': 'e', 'ë': 'e', 'ê': 'e', 'à': 'a', 'â': 'a',
  'î': 'i', 'ï': 'i', 'ô': 'o', 'ù': 'u', 'û': 'u',
  'ñ': 'n', 'ÿ': 'y',
};

/** Build a regex that matches any diacritical character */
const DIACRITICS_RE = new RegExp(
  `[${Object.keys(DIACRITICS).join('')}]`,
  'g'
);

/** Measurement units regex — matches common units with optional preceding number */
const UNITS_RE =
  /\b\d*[.,]?\d+\s*(kg|g|gr|l|lt|ml|cl|dl|gab|gb|st|pcs?|pack|pak|iep|x)\b/gi;

/** Standalone numbers (not part of a word) */
const NUMBERS_RE = /\b\d+([.,]\d+)?\b/g;

/** Non-alphanumeric (keeping spaces) */
const PUNCTUATION_RE = /[^a-z0-9\s]/g;

/** Multiple spaces */
const MULTI_SPACE_RE = /\s{2,}/g;

/**
 * Normalize a product name to a canonical form.
 * Deterministic: same input always produces the same output.
 */
export function normalizeProductName(raw: string): string {
  let name = raw;

  // 1. Remove diacritics
  name = name.replace(DIACRITICS_RE, (ch) => DIACRITICS[ch] || ch);

  // Also handle uppercase diacritics
  name = name.replace(
    new RegExp(`[${Object.keys(DIACRITICS).map((c) => c.toUpperCase()).join('')}]`, 'g'),
    (ch) => DIACRITICS[ch.toLowerCase()] || ch
  );

  // 2. Lowercase
  name = name.toLowerCase();

  // 3. Remove measurement units with numbers
  name = name.replace(UNITS_RE, '');

  // 4. Remove remaining standalone numbers
  name = name.replace(NUMBERS_RE, '');

  // 5. Remove punctuation
  name = name.replace(PUNCTUATION_RE, ' ');

  // 6. Trim and collapse spaces
  name = name.replace(MULTI_SPACE_RE, ' ').trim();

  return name;
}

/**
 * Create a display-friendly product name from the original OCR text.
 * Less aggressive than normalization — keeps the name readable.
 */
export function displayName(raw: string): string {
  let name = raw.trim();

  // Remove price if trailing
  name = name.replace(/\s+\d+[.,]\d{2}\s*(eur|€)?\s*$/i, '');

  // Capitalize first letter
  if (name.length > 0) {
    name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  }

  return name;
}
