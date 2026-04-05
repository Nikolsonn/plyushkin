import path from 'path';

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

export const config = {
  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: (process.env['ALLOWED_CHAT_IDS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  },
  api: {
    port: parseInt(env('API_PORT', '3000'), 10),
  },
  db: {
    path: path.resolve(env('DB_PATH', './data/plyushkin.db')),
  },
  images: {
    dir: path.resolve(env('IMAGE_DIR', './data/images')),
    maxSize: parseInt(env('MAX_IMAGE_SIZE', '3145728'), 10), // 3MB
    maxWidth: parseInt(env('MAX_IMAGE_WIDTH', '800'), 10),
  },
  ocr: {
    engine: env('OCR_ENGINE', 'native') as 'tesseractjs' | 'native',
    lang: env('TESSERACT_LANG', 'lav+eng'),
  },
  log: {
    level: env('LOG_LEVEL', 'info'),
  },
  dedup: {
    threshold: parseFloat(env('SIMILARITY_THRESHOLD', '0.80')),
  },
} as const;
