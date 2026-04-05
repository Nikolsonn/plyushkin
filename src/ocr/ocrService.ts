import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * OCR Service — extracts text from preprocessed receipt images.
 *
 * Two engines are supported:
 *
 * 1. "native" (recommended for Raspberry Pi)
 *    Calls the system `tesseract` binary via child_process.spawn().
 *    On RPi 3, processes an 800px-wide receipt in ~3-5 seconds.
 *    Requires: sudo apt install tesseract-ocr tesseract-ocr-lav
 *
 * 2. "tesseractjs" (fallback, no system dependency)
 *    Uses tesseract.js WASM engine. Portable but 10-14x slower on ARM.
 *    On RPi 3, expect ~30-60 seconds per image.
 *    Worker is kept alive and recycled every 20 recognitions to prevent
 *    memory leaks (known tesseract.js issue).
 */

const TMP_DIR = '/tmp/ocr';

// ── Native Tesseract via CLI ───────────────────────────────────────────

async function ensureTmpDir(): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

async function ocrNative(imageBuffer: Buffer): Promise<string> {
  await ensureTmpDir();

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const inputPath = path.join(TMP_DIR, `ocr_${id}.png`);
  const outputBase = path.join(TMP_DIR, `ocr_${id}`);
  const outputPath = `${outputBase}.txt`;

  try {
    await fs.writeFile(inputPath, imageBuffer);

    const text = await new Promise<string>((resolve, reject) => {
      const args = [
        inputPath,
        outputBase,
        '-l', config.ocr.lang,
        '--oem', '1',   // LSTM neural net engine
        '--psm', '6',   // Assume uniform block of text
        '-c', 'debug_file=/dev/null',
      ];

      const proc = spawn('tesseract', args, {
        env: {
          ...process.env,
          OMP_THREAD_LIMIT: '2', // Limit threads to avoid saturating all 4 cores
        },
      });

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`Tesseract exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          const content = await fs.readFile(outputPath, 'utf8');
          resolve(content.trim());
        } catch (err) {
          reject(new Error(`Failed to read Tesseract output: ${err}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn tesseract: ${err.message}. Is tesseract-ocr installed?`));
      });
    });

    return text;
  } finally {
    // Cleanup temp files silently
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

// ── Tesseract.js WASM engine ───────────────────────────────────────────

let jsWorker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | null = null;
let jsWorkerUseCount = 0;
const MAX_WORKER_USES = 20; // Recycle to prevent memory leaks

async function getJsWorker() {
  if (jsWorker && jsWorkerUseCount < MAX_WORKER_USES) {
    return jsWorker;
  }

  // Terminate old worker if recycling
  if (jsWorker) {
    logger.info('Recycling tesseract.js worker to free memory');
    await jsWorker.terminate();
    jsWorker = null;
    jsWorkerUseCount = 0;
  }

  const Tesseract = await import('tesseract.js');
  const worker = await Tesseract.createWorker(config.ocr.lang, 1, {
    // Minimize logging in production
    logger: config.log.level === 'debug' ? (m: unknown) => logger.debug(m, 'tesseract.js') : undefined,
  });

  jsWorker = worker;
  return worker;
}

async function ocrTesseractJs(imageBuffer: Buffer): Promise<string> {
  const worker = await getJsWorker();
  const { data } = await worker.recognize(imageBuffer);
  jsWorkerUseCount++;
  return data.text.trim();
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Extract text from a preprocessed receipt image.
 * Returns raw OCR text (unprocessed).
 */
export async function extractText(imageBuffer: Buffer): Promise<string> {
  const start = Date.now();
  let text: string;

  if (config.ocr.engine === 'native') {
    text = await ocrNative(imageBuffer);
  } else {
    text = await ocrTesseractJs(imageBuffer);
  }

  const ms = Date.now() - start;
  logger.info({ engine: config.ocr.engine, ms, chars: text.length }, 'OCR complete');

  return text;
}

/**
 * Graceful shutdown — terminate tesseract.js worker if active.
 */
export async function shutdownOcr(): Promise<void> {
  if (jsWorker) {
    await jsWorker.terminate();
    jsWorker = null;
    logger.info('Tesseract.js worker terminated');
  }
}
