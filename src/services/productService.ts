import { eq } from 'drizzle-orm';
import { getDb } from '../database/db';
import { products } from '../database/schema';
import type { Product } from '../database/schema';
import { normalizeProductName, displayName } from '../parser/productNormalizer';
import { findBestMatch } from './deduplicationService';
import { logger } from '../utils/logger';

/**
 * Product service — manages the canonical product catalog.
 *
 * Responsibilities:
 * - Resolve raw product names to canonical products (normalize + dedup)
 * - Create new products when no match exists
 * - Cache existing normalized names in memory for fast dedup lookups
 *
 * The in-memory name cache avoids repeated DB queries during receipt
 * processing. For a typical RPi deployment with <10K products,
 * this cache uses <1MB of RAM.
 */

/** In-memory cache of normalized product names for dedup lookups */
let nameCache: string[] | null = null;

function loadNameCache(): string[] {
  if (nameCache === null) {
    const db = getDb();
    const rows = db.select({ name: products.normalizedName }).from(products).all();
    nameCache = rows.map((r) => r.name);
    logger.debug({ count: nameCache.length }, 'Product name cache loaded');
  }
  return nameCache;
}

/** Invalidate cache (call after inserts) */
function invalidateCache(): void {
  nameCache = null;
}

/**
 * Resolve a raw product name to a canonical product ID.
 * Creates the product if it doesn't exist.
 *
 * Flow:
 * 1. Normalize the raw name
 * 2. Check for exact match in DB
 * 3. Check for fuzzy match via deduplication
 * 4. Create new product if no match
 */
export function resolveProduct(rawName: string): Product {
  const db = getDb();
  const normalized = normalizeProductName(rawName);

  if (!normalized) {
    throw new Error(`Cannot normalize empty product name: "${rawName}"`);
  }

  // Exact match
  const exact = db
    .select()
    .from(products)
    .where(eq(products.normalizedName, normalized))
    .get();

  if (exact) return exact;

  // Fuzzy dedup match
  const existingNames = loadNameCache();
  const fuzzyMatch = findBestMatch(normalized, existingNames);

  if (fuzzyMatch) {
    const matched = db
      .select()
      .from(products)
      .where(eq(products.normalizedName, fuzzyMatch))
      .get();

    if (matched) {
      logger.info(
        { raw: rawName, normalized, matchedTo: fuzzyMatch },
        'Product deduplicated'
      );
      return matched;
    }
  }

  // Create new product
  const display = displayName(rawName);
  const result = db
    .insert(products)
    .values({
      normalizedName: normalized,
      displayName: display,
    })
    .returning()
    .get();

  invalidateCache();
  logger.info({ id: result.id, normalized, display }, 'New product created');

  return result;
}

/** Get all products */
export function getAllProducts(): Product[] {
  return getDb().select().from(products).all();
}

/** Search products by name */
export function searchProducts(query: string): Product[] {
  const db = getDb();
  const normalized = normalizeProductName(query);
  const all = db.select().from(products).all();

  // Filter by substring match on normalized name
  return all.filter(
    (p) =>
      p.normalizedName.includes(normalized) ||
      p.displayName.toLowerCase().includes(query.toLowerCase())
  );
}
