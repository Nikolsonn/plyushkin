import { logger } from '../utils/logger';

/**
 * Receipt parser — extracts product lines with prices from raw OCR text.
 *
 * OCR noise handling strategy:
 * 1. Character replacement rules for common OCR confusions (1↔l, 0↔O, etc.)
 * 2. Price pattern detection with multiple formats (1.25, 1,25, 1.25 EUR)
 * 3. Line filtering: skip headers, totals, dates, tax lines, payment info
 * 4. Confidence: only lines matching a price pattern are considered products
 */

export interface ParsedItem {
  productName: string;
  price: number;
  quantity: number;
  rawLine: string;
}

export interface ParsedReceipt {
  items: ParsedItem[];
  rawText: string;
}

// ── OCR noise cleanup ──────────────────────────────────────────────────

/** Common OCR character confusions */
const CHAR_REPLACEMENTS: [RegExp, string][] = [
  [/[|]/g, 'l'],    // Pipe → l
  [/[{}]/g, ''],     // Braces → remove
  [/[`´]/g, "'"],    // Backtick variants → apostrophe
];

/** Clean up a single OCR line */
function cleanLine(line: string): string {
  let cleaned = line.trim();
  for (const [pattern, replacement] of CHAR_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned;
}

// ── Price extraction ───────────────────────────────────────────────────

/**
 * Price patterns found on Latvian/European receipts:
 * - 1.25         (dot decimal)
 * - 1,25         (comma decimal)
 * - 1.25 EUR     (with currency)
 * - 1,25€        (with euro symbol)
 * - 1.25 A       (tax category marker)
 * - -1.25        (negative = discount)
 *
 * The regex captures the last price-like pattern on the line,
 * since receipts typically have: PRODUCT_NAME ... PRICE
 */
const PRICE_RE =
  /(-?\d{1,4})[.,](\d{2})\s*(?:eur|€|[a-c])?\s*$/i;

/**
 * Alternative: price somewhere in the line (not necessarily at end).
 * Used as fallback.
 */
const PRICE_ANYWHERE_RE =
  /(-?\d{1,4})[.,](\d{2})\s*(?:eur|€)?/gi;

/** Extract price from end of line. Returns null if no price found. */
function extractPrice(line: string): number | null {
  const match = line.match(PRICE_RE);
  if (!match) return null;

  const whole = parseInt(match[1], 10);
  const decimal = parseInt(match[2], 10);
  const price = whole + decimal / 100;

  // Sanity check: typical grocery prices are 0.01 - 999.99
  if (price < 0.01 || price > 999.99) return null;

  return price;
}

// ── Quantity extraction ────────────────────────────────────────────────

/**
 * Quantity patterns:
 * - "2 x BANANI"         → qty 2
 * - "BANANI x2"          → qty 2
 * - "BANANI  2 gab"      → qty 2
 * - "0.500 kg"           → qty 0.5
 */
const QTY_PATTERNS: RegExp[] = [
  /^(\d+)\s*[xх*]\s+/i,          // "2 x PRODUCT"
  /\s+(\d+)\s*(?:gab|gb|st|pcs)\b/i,  // "PRODUCT 2 gab"
  /(\d+[.,]\d+)\s*kg\b/i,        // "0.500 kg"
  /\s+[xх*]\s*(\d+)\s*$/i,       // "PRODUCT x2" at end
];

function extractQuantity(line: string): number {
  for (const pattern of QTY_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return parseFloat(match[1].replace(',', '.'));
    }
  }
  return 1;
}

// ── Line filtering ─────────────────────────────────────────────────────

/** Lines to skip — headers, totals, metadata.
 *  Using (?:^|\s) instead of \b because \b doesn't work with
 *  Latvian diacritics (ā, č, ē, etc.) in JavaScript regex. */
const SKIP_PATTERNS: RegExp[] = [
  /^\s*$/,                          // Empty
  /^-{3,}$/,                        // Separator lines
  /^={3,}$/,
  /^[*]{3,}$/,
  /(?:^|\s)(kopā|kopa|kopsumma|total|summa|итого)(?:\s|$)/i,  // Totals
  /(?:^|\s)(pvn|nodok|tax|nds|ндс)/i,                         // Tax lines
  /(?:^|\s)(atlaides?|atlaide|discount|скидка)/i,              // Discount headers
  /(?:^|\s)(karte|card|наличн|skaidra)/i,                      // Payment method
  /(?:^|\s)(kases?\s*[čc]eks?|receipt|[čc]eks?)/i,             // "Receipt" label
  /(?:^|\s)(datums|date|laiks|time|дата|время)/i,              // Date/time labels
  /(?:^|\s)(paldies|[aā][čc]i[uū]|спасибо|thank)/i,           // Thank you messages
  /(?:^|\s)(adrese|address|адрес|t[āa]lr|tel)/i,               // Store address/phone
  /^\d{2}[./-]\d{2}[./-]\d{2,4}/,                             // Date patterns at start
  /^\d{2}:\d{2}/,                                              // Time patterns at start
  /(?:^|\s)reg\.?\s*n/i,                                       // Registration number
  /(?:^|\s)sia(?:\s|$)/i,                                      // SIA (Ltd.)
];

function shouldSkipLine(line: string): boolean {
  return SKIP_PATTERNS.some((pat) => pat.test(line));
}

// ── Main parser ────────────────────────────────────────────────────────

/**
 * Parse raw OCR text into structured product items.
 */
export function parseReceipt(rawText: string): ParsedReceipt {
  const lines = rawText.split('\n');
  const items: ParsedItem[] = [];

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);

    // Skip empty or metadata lines
    if (!line || shouldSkipLine(line)) continue;

    // Must contain a price
    const price = extractPrice(line);
    if (price === null) continue;

    // Skip negative prices (discounts/returns) — or include as negative
    if (price < 0) continue;

    // Extract product name: everything before the price
    const priceMatch = line.match(PRICE_RE);
    if (!priceMatch) continue;

    const priceStartIndex = line.lastIndexOf(priceMatch[0]);
    let productName = line.substring(0, priceStartIndex).trim();

    // Clean up product name
    // Remove leading quantity markers like "2 x "
    productName = productName.replace(/^\d+\s*[xх*]\s+/i, '');
    // Remove trailing quantity like " x2"
    productName = productName.replace(/\s+[xх*]\s*\d+\s*$/, '');

    // Skip if product name is too short (likely noise)
    if (productName.length < 2) continue;

    const quantity = extractQuantity(line);

    items.push({
      productName,
      price,
      quantity,
      rawLine: line,
    });
  }

  logger.info({ lineCount: lines.length, itemCount: items.length }, 'Receipt parsed');

  return { items, rawText };
}
