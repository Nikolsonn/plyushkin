import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';
import * as schema from './schema';

let sqlite: Database.Database | null = null;

/**
 * Returns a singleton Drizzle ORM instance backed by better-sqlite3.
 *
 * better-sqlite3 is synchronous (no event-loop blocking for simple queries)
 * and has excellent performance on ARM. SQLite WAL mode enables concurrent
 * reads while a write is in progress — important when the API serves
 * queries while a receipt is being processed.
 */
export function getDb() {
  if (!sqlite) {
    sqlite = new Database(config.db.path);

    // WAL mode: concurrent reads + writes, better crash recovery
    sqlite.pragma('journal_mode = WAL');
    // Synchronous NORMAL: safe for WAL, faster than FULL
    sqlite.pragma('synchronous = NORMAL');
    // 2MB cache — modest for RPi 3 1GB RAM
    sqlite.pragma('cache_size = -2000');
    // Enable foreign keys
    sqlite.pragma('foreign_keys = ON');

    logger.info({ path: config.db.path }, 'SQLite database opened');
  }

  return drizzle(sqlite, { schema });
}

/** Run database migrations (create tables if not exist) */
export function migrateDb(): void {
  if (!sqlite) {
    getDb(); // Ensure connection
  }

  sqlite!.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store TEXT,
      datetime TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      image_path TEXT,
      telegram_chat_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES receipts(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      original_name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity REAL DEFAULT 1,
      raw_line TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_purchase_items_receipt
      ON purchase_items(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_product
      ON purchase_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_products_normalized_name
      ON products(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_receipts_store
      ON receipts(store);
    CREATE INDEX IF NOT EXISTS idx_receipts_datetime
      ON receipts(datetime);
  `);

  logger.info('Database migrations complete');
}

/** Graceful shutdown */
export function closeDb(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    logger.info('SQLite database closed');
  }
}
