/**
 * Receipt Price Tracker — Main entry point.
 *
 * Starts all services in order:
 * 1. Load environment variables
 * 2. Run database migrations
 * 3. Start REST API server
 * 4. Start Telegram bot
 *
 * Handles graceful shutdown on SIGINT/SIGTERM.
 */

// Load .env file before anything else
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// Now import everything that depends on config
import { config } from './config';
import { logger } from './utils/logger';
import { migrateDb, closeDb } from './database/db';
import { startApiServer } from './api/server';
import { startBot, stopBot } from './bot/telegramBot';
import { shutdownOcr } from './ocr/ocrService';

async function main(): Promise<void> {
  logger.info('Starting Receipt Price Tracker...');
  logger.info({
    ocrEngine: config.ocr.engine,
    lang: config.ocr.lang,
    apiPort: config.api.port,
    maxImageWidth: config.images.maxWidth,
  }, 'Configuration');

  // 1. Database
  migrateDb();

  // 2. API server
  await startApiServer();

  // 3. Telegram bot
  await startBot();

  logger.info('All services started');

  // ── Graceful shutdown ────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    try {
      await stopBot();
      await shutdownOcr();
      closeDb();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
