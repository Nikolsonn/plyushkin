import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.log.level,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
  // Minimize memory: disable serializers, use timestamps
  timestamp: pino.stdTimeFunctions.isoTime,
  // Reduce log object size
  base: undefined,
});

export type Logger = typeof logger;
