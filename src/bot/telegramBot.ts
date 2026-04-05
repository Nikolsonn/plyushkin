import TelegramBot from 'node-telegram-bot-api';
import https from 'https';
import http from 'http';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processReceipt, getStats } from '../services/receiptService';
import { getPriceHistoryFuzzy } from '../services/receiptService';
import { computePriceStats } from '../utils/priceStats';

/**
 * Telegram bot — receives receipt photos and returns extracted data.
 *
 * Uses long-polling (not webhooks) since we're behind a home router
 * without a public IP. Polling is simpler and doesn't require port forwarding.
 *
 * Commands:
 *   /start          — Welcome message
 *   /stats          — Purchase statistics
 *   /prices <name>  — Price history for a product
 *   /help           — List commands
 *
 * Photo handling:
 *   Any photo sent to the bot is treated as a receipt.
 *   The bot downloads the highest-resolution version, processes it,
 *   and replies with extracted products and prices.
 */

let bot: TelegramBot | null = null;

/** Processing lock — one receipt at a time to avoid overloading RPi */
let isProcessing = false;

/**
 * Download file from URL to Buffer using core http/https.
 * No external download library needed.
 */
function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let totalSize = 0;

      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > config.images.maxSize) {
          res.destroy();
          reject(new Error('Image too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Format a number as a price string.
 */
function formatPrice(price: number): string {
  return `€${price.toFixed(2)}`;
}

export async function startBot(): Promise<void> {
  const b = new TelegramBot(config.telegram.token, {
    polling: {
      interval: 2000,     // Check every 2s (gentle on CPU)
      autoStart: true,
      params: {
        timeout: 30,      // Long-poll timeout
        allowed_updates: ['message'],
      },
    },
  });

  bot = b;

  logger.info('Telegram bot started (polling mode)');

  /** Check if a chat is authorized. Returns false and ignores if not. */
  function isAuthorized(chatId: number): boolean {
    const allowed = config.telegram.allowedChatIds;
    if (allowed.length === 0) return true; // no whitelist = allow all
    return allowed.includes(chatId);
  }

  // ── /start command ───────────────────────────────────────────────────
  b.onText(/\/start/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    await b.sendMessage(
      msg.chat.id,
      '🧾 *Receipt Price Tracker*\n\n' +
        'Send me a photo of a receipt and I will extract the products and prices.\n\n' +
        '*Commands:*\n' +
        '/stats — Purchase statistics\n' +
        '/prices <product> — Price history\n' +
        '/help — Show this help',
      { parse_mode: 'Markdown' }
    );
  });

  // ── /help command ────────────────────────────────────────────────────
  b.onText(/\/help/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    await b.sendMessage(
      msg.chat.id,
      '*Commands:*\n' +
        '/stats — Purchase statistics\n' +
        '/prices <product> — Price history for a product\n' +
        '/help — Show this help\n\n' +
        'Send a receipt photo to extract prices.',
      { parse_mode: 'Markdown' }
    );
  });

  // ── /stats command ───────────────────────────────────────────────────
  b.onText(/\/stats/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      const stats = getStats();
      const topList = stats.topProducts
        .slice(0, 5)
        .map(
          (p, i) =>
            `${i + 1}. ${p.name} — ${formatPrice(p.avgPrice)} avg (${p.count}x)`
        )
        .join('\n');

      await b.sendMessage(
        msg.chat.id,
        `📊 *Purchase Statistics*\n\n` +
          `Receipts: ${stats.receipts}\n` +
          `Products: ${stats.products}\n` +
          `Total items: ${stats.totalItems}\n` +
          `Total spent: ${formatPrice(stats.totalSpent)}\n` +
          `Average price: ${formatPrice(stats.averagePrice)}\n\n` +
          `*Top products:*\n${topList || 'No data yet'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error({ err }, 'Error handling /stats');
      await b.sendMessage(msg.chat.id, '❌ Error fetching statistics.');
    }
  });

  // ── /prices command ──────────────────────────────────────────────────
  b.onText(/\/prices\s+(.+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await b.sendMessage(msg.chat.id, 'Usage: /prices <product name>');
      return;
    }

    try {
      const { history } = getPriceHistoryFuzzy(query);

      if (history.length === 0) {
        await b.sendMessage(msg.chat.id, `No price data found for "${query}".`);
        return;
      }

      const stats = computePriceStats(history.map((h) => h.price));

      const recent = history
        .slice(0, 5)
        .map(
          (h) =>
            `• ${formatPrice(h.price)} at ${h.store ?? 'unknown'} (${new Date(h.date).toLocaleDateString('lv-LV')})`
        )
        .join('\n');

      await b.sendMessage(
        msg.chat.id,
        `💰 *${query}*\n\n` +
          `Min: ${formatPrice(stats.min)}\n` +
          `Max: ${formatPrice(stats.max)}\n` +
          `Avg: ${formatPrice(stats.avg)}\n` +
          `Records: ${history.length}\n\n` +
          `*Recent:*\n${recent}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error({ err, query }, 'Error handling /prices');
      await b.sendMessage(msg.chat.id, '❌ Error fetching price history.');
    }
  });

  // ── Photo handler (receipt processing) ───────────────────────────────
  b.on('photo', async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (!msg.photo || msg.photo.length === 0) return;

    if (isProcessing) {
      await b.sendMessage(
        msg.chat.id,
        '⏳ Already processing another receipt. Please wait...'
      );
      return;
    }

    isProcessing = true;
    const statusMsg = await b.sendMessage(msg.chat.id, '🔄 Processing receipt...');

    try {
      // Get highest resolution photo
      const photo = msg.photo[msg.photo.length - 1];
      const fileInfo = await b.getFile(photo.file_id);

      if (!fileInfo.file_path) {
        throw new Error('Could not get file path from Telegram');
      }

      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${fileInfo.file_path}`;
      const imageBuffer = await downloadFile(fileUrl);

      // Process the receipt
      const result = await processReceipt(imageBuffer, msg.chat.id);

      // Format response
      const itemsList = result.items
        .map((item) => {
          const qty = item.quantity !== 1 ? ` x${item.quantity}` : '';
          return `• ${item.name}${qty} — ${formatPrice(item.price)}`;
        })
        .join('\n');

      const total = result.items.reduce(
        (s, item) => s + item.price * item.quantity,
        0
      );

      await b.editMessageText(
        `✅ *Receipt processed*\n\n` +
          `Store: ${result.store ?? 'Unknown'}\n` +
          `Items: ${result.itemCount}\n` +
          `Time: ${(result.processingTimeMs / 1000).toFixed(1)}s\n\n` +
          `*Products:*\n${itemsList}\n\n` +
          `*Total: ${formatPrice(total)}*`,
        {
          chat_id: msg.chat.id,
          message_id: statusMsg.message_id,
          parse_mode: 'Markdown',
        }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'Receipt processing failed');
      await b.editMessageText(
        `❌ *Processing failed*\n\n${message}`,
        {
          chat_id: msg.chat.id,
          message_id: statusMsg.message_id,
          parse_mode: 'Markdown',
        }
      );
    } finally {
      isProcessing = false;
    }
  });

  // ── Error handler ────────────────────────────────────────────────────
  b.on('polling_error', (err: Error & { code?: string }) => {
    // Don't log ETIMEOUT — it's normal for long-polling
    if (err?.code === 'ETIMEOUT') return;
    logger.error({ err: err?.message || err }, 'Telegram polling error');
  });
}

/** Graceful shutdown */
export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}
