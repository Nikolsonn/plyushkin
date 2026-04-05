import { promises as fs } from 'fs';
import path from 'path';
import { eq, desc, sql } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../database/db';
import { receipts, purchaseItems, products } from '../database/schema';
import type { Receipt } from '../database/schema';
import { preprocessImage, validateImage } from '../utils/imagePreprocess';
import { extractText } from '../ocr/ocrService';
import { parseReceipt, type ParsedReceipt } from '../parser/receiptParser';
import { detectStore } from '../parser/storeDetector';
import { normalizeProductName } from '../parser/productNormalizer';
import { resolveProduct, searchProducts } from './productService';
import { logger } from '../utils/logger';

/**
 * Receipt processing orchestrator — the central pipeline.
 *
 * Pipeline steps:
 * 1. Validate image
 * 2. Preprocess (resize, grayscale, contrast)
 * 3. OCR text extraction
 * 4. Parse product lines
 * 5. Detect store
 * 6. Normalize & deduplicate products
 * 7. Store everything in SQLite
 *
 * Returns a summary of what was extracted.
 */

export interface ProcessingResult {
  receiptId: number;
  store: string | null;
  itemCount: number;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
  }>;
  ocrText: string;
  processingTimeMs: number;
}

/**
 * Process a receipt image end-to-end.
 */
export async function processReceipt(
  imageBuffer: Buffer,
  chatId?: number
): Promise<ProcessingResult> {
  const start = Date.now();

  // 1. Validate
  const validationError = validateImage(imageBuffer);
  if (validationError) {
    throw new Error(validationError);
  }

  // 2. Save original image
  const imageFilename = `receipt_${Date.now()}.jpg`;
  const imagePath = path.join(config.images.dir, imageFilename);
  await fs.mkdir(config.images.dir, { recursive: true });
  await fs.writeFile(imagePath, imageBuffer);

  // 3. Preprocess
  const preprocessed = await preprocessImage(imageBuffer);

  // 4. OCR
  const rawText = await extractText(preprocessed);

  if (!rawText || rawText.length < 10) {
    throw new Error('OCR returned insufficient text. The image may not contain a readable receipt.');
  }

  // 5. Parse
  const parsed: ParsedReceipt = parseReceipt(rawText);

  if (parsed.items.length === 0) {
    throw new Error(
      'No product lines found in receipt. OCR text may be too noisy or image quality too low.'
    );
  }

  // 6. Detect store
  const store = detectStore(rawText);

  // 7. Store receipt
  const db = getDb();
  const receipt = db
    .insert(receipts)
    .values({
      store,
      datetime: new Date().toISOString(),
      rawText,
      imagePath: imageFilename,
      telegramChatId: chatId ?? null,
    })
    .returning()
    .get();

  // 8. Resolve products and store items
  const storedItems: ProcessingResult['items'] = [];

  for (const item of parsed.items) {
    try {
      const product = resolveProduct(item.productName);

      db.insert(purchaseItems)
        .values({
          receiptId: receipt.id,
          productId: product.id,
          originalName: item.productName,
          price: item.price,
          quantity: item.quantity,
          rawLine: item.rawLine,
        })
        .run();

      storedItems.push({
        name: product.displayName,
        price: item.price,
        quantity: item.quantity,
      });
    } catch (err) {
      logger.warn({ item, err }, 'Failed to process item, skipping');
    }
  }

  const processingTimeMs = Date.now() - start;

  logger.info(
    {
      receiptId: receipt.id,
      store,
      items: storedItems.length,
      ms: processingTimeMs,
    },
    'Receipt processed'
  );

  return {
    receiptId: receipt.id,
    store,
    itemCount: storedItems.length,
    items: storedItems,
    ocrText: rawText,
    processingTimeMs,
  };
}

// ── Query helpers ──────────────────────────────────────────────────────

/** Get all receipts (newest first) */
export function getReceipts(limit = 50): Receipt[] {
  return getDb()
    .select()
    .from(receipts)
    .orderBy(desc(receipts.datetime))
    .limit(limit)
    .all();
}

/** Get price history for a product by normalized name */
export function getPriceHistory(normalizedName: string) {
  const db = getDb();
  return db
    .select({
      price: purchaseItems.price,
      quantity: purchaseItems.quantity,
      store: receipts.store,
      date: receipts.datetime,
      originalName: purchaseItems.originalName,
    })
    .from(purchaseItems)
    .innerJoin(products, eq(purchaseItems.productId, products.id))
    .innerJoin(receipts, eq(purchaseItems.receiptId, receipts.id))
    .where(eq(products.normalizedName, normalizedName))
    .orderBy(desc(receipts.datetime))
    .all();
}

/** Get price history with fuzzy product matching */
export function getPriceHistoryFuzzy(query: string) {
  const normalized = normalizeProductName(query);
  let history = getPriceHistory(normalized);
  let product = null;

  if (history.length === 0) {
    const matches = searchProducts(query);
    if (matches.length > 0) {
      product = matches[0];
      history = getPriceHistory(product.normalizedName);
    }
  }

  return { history, product };
}

/** Get distinct stores */
export function getStores(): string[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ store: receipts.store })
    .from(receipts)
    .where(sql`${receipts.store} IS NOT NULL`)
    .all();
  return rows.map((r) => r.store!);
}

/** Purchase statistics */
export function getStats() {
  const db = getDb();

  const receiptCount = db
    .select({ count: sql<number>`count(*)` })
    .from(receipts)
    .get()!.count;

  const productCount = db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .get()!.count;

  const itemCount = db
    .select({ count: sql<number>`count(*)` })
    .from(purchaseItems)
    .get()!.count;

  const totalSpent = db
    .select({ total: sql<number>`coalesce(sum(price * quantity), 0)` })
    .from(purchaseItems)
    .get()!.total;

  const avgPrice = db
    .select({ avg: sql<number>`coalesce(avg(price), 0)` })
    .from(purchaseItems)
    .get()!.avg;

  // Top 10 most purchased products
  const topProducts = db
    .select({
      name: products.displayName,
      normalizedName: products.normalizedName,
      count: sql<number>`count(*)`,
      avgPrice: sql<number>`round(avg(${purchaseItems.price}), 2)`,
    })
    .from(purchaseItems)
    .innerJoin(products, eq(purchaseItems.productId, products.id))
    .groupBy(products.id)
    .orderBy(sql`count(*) DESC`)
    .limit(10)
    .all();

  return {
    receipts: receiptCount,
    products: productCount,
    totalItems: itemCount,
    totalSpent: Math.round(totalSpent * 100) / 100,
    averagePrice: Math.round(avgPrice * 100) / 100,
    topProducts,
  };
}
