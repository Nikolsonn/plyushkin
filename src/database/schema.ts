import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

/** Receipt scan records */
export const receipts = sqliteTable('receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  store: text('store'),
  datetime: text('datetime').notNull(), // ISO 8601
  rawText: text('raw_text').notNull(),
  imagePath: text('image_path'),
  telegramChatId: integer('telegram_chat_id'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** Canonical product names (deduplicated) */
export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  normalizedName: text('normalized_name').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** Individual line items from receipts */
export const purchaseItems = sqliteTable('purchase_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  receiptId: integer('receipt_id')
    .notNull()
    .references(() => receipts.id),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  originalName: text('original_name').notNull(),
  price: real('price').notNull(),
  quantity: real('quantity').default(1),
  rawLine: text('raw_line').notNull(),
});

// Types inferred from schema
export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type PurchaseItem = typeof purchaseItems.$inferSelect;
export type NewPurchaseItem = typeof purchaseItems.$inferInsert;
