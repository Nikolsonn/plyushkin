import Fastify from 'fastify';
import { config } from '../config';
import { logger } from '../utils/logger';
import { registerRoutes } from './routes';

/**
 * Fastify HTTP server — serves the REST API.
 *
 * Fastify is chosen over Express for:
 * - 2-3x faster request handling
 * - Lower memory footprint
 * - Built-in JSON serialization
 * - Schema-based validation (optional)
 *
 * Binds to 0.0.0.0 so it's accessible from the local network
 * (e.g., from a phone or another device on the same WiFi).
 */
export async function startApiServer(): Promise<void> {
  const app = Fastify({
    logger: false, // We use our own pino logger
    // Disable unnecessary features for RPi
    trustProxy: false,
    bodyLimit: 1048576, // 1MB — API only accepts JSON, not images
  });

  await registerRoutes(app);

  await app.listen({
    port: config.api.port,
    host: '0.0.0.0',
  });

  logger.info({ port: config.api.port }, 'REST API server started');
}
