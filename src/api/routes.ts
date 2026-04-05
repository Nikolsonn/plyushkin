import type { FastifyInstance } from 'fastify';
import { normalizeProductName } from '../parser/productNormalizer';
import { getAllProducts, searchProducts } from '../services/productService';
import {
  getReceipts,
  getPriceHistoryFuzzy,
  getStores,
  getStats,
} from '../services/receiptService';
import { computePriceStats } from '../utils/priceStats';

/**
 * REST API routes — lightweight Fastify handlers.
 *
 * All endpoints return JSON. No authentication (local network only).
 *
 * Endpoints:
 *   GET /products            — List all products (optional ?q= search)
 *   GET /products/:name/prices — Price history for a product
 *   GET /stores              — List detected stores
 *   GET /stats               — Purchase statistics
 *   GET /receipts            — List recent receipts
 *   GET /health              — Health check
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Health check ─────────────────────────────────────────────────────
  app.get('/health', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  // ── Products ─────────────────────────────────────────────────────────
  app.get<{
    Querystring: { q?: string };
  }>('/products', async (request) => {
    const query = request.query.q;
    const items = query ? searchProducts(query) : getAllProducts();
    return {
      count: items.length,
      products: items.map((p) => ({
        id: p.id,
        name: p.displayName,
        normalizedName: p.normalizedName,
      })),
    };
  });

  // ── Price history ────────────────────────────────────────────────────
  app.get<{
    Params: { name: string };
  }>('/products/:name/prices', async (request, reply) => {
    const rawName = decodeURIComponent(request.params.name);
    const normalized = normalizeProductName(rawName);

    if (!normalized) {
      return reply.status(400).send({ error: 'Invalid product name' });
    }

    const { history, product: fuzzyProduct } = getPriceHistoryFuzzy(rawName);

    if (history.length === 0) {
      return reply.status(404).send({
        error: 'Product not found',
        suggestion: 'Try GET /products?q=your_search',
      });
    }

    if (fuzzyProduct) {
      return {
        product: fuzzyProduct.displayName,
        normalizedName: fuzzyProduct.normalizedName,
        priceCount: history.length,
        prices: history,
      };
    }

    const summary = computePriceStats(history.map((h) => h.price));

    return {
      product: rawName,
      normalizedName: normalized,
      priceCount: history.length,
      summary,
      prices: history,
    };
  });

  // ── Stores ───────────────────────────────────────────────────────────
  app.get('/stores', async () => {
    const stores = getStores();
    return { count: stores.length, stores };
  });

  // ── Stats ────────────────────────────────────────────────────────────
  app.get('/stats', async () => {
    return getStats();
  });

  // ── Receipts ─────────────────────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string };
  }>('/receipts', async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const list = getReceipts(limit);
    return {
      count: list.length,
      receipts: list.map((r) => ({
        id: r.id,
        store: r.store,
        datetime: r.datetime,
        imagePath: r.imagePath,
      })),
    };
  });
}
