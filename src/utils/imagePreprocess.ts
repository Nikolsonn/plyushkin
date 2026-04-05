import sharp from 'sharp';
import { config } from '../config';
import { logger } from './logger';

/**
 * Preprocesses a receipt image for optimal OCR accuracy on constrained hardware.
 *
 * Pipeline:
 * 1. Resize to max width (800px default) — this is THE critical optimization
 *    that reduces Tesseract processing from 56s to ~4s on Raspberry Pi.
 * 2. Convert to grayscale — removes color channel overhead.
 * 3. Normalize contrast — improves text/background separation.
 * 4. Sharpen — recovers edge detail lost in resize.
 * 5. Output as uncompressed PNG — no CPU spent on compression, Tesseract
 *    reads raw pixel data anyway.
 */
export async function preprocessImage(input: Buffer): Promise<Buffer> {
  const start = Date.now();

  const metadata = await sharp(input).metadata();
  logger.debug(
    { width: metadata.width, height: metadata.height, size: input.length },
    'Original image'
  );

  const processed = await sharp(input)
    // Resize down — largest OCR speedup. `inside` preserves aspect ratio.
    .resize({
      width: config.images.maxWidth,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .grayscale()
    .normalize() // Auto-adjust contrast
    .sharpen({ sigma: 1.0 }) // Recover edges after resize
    .png({ compressionLevel: 0 }) // Fastest: no compression
    .toBuffer();

  logger.debug(
    { ms: Date.now() - start, outputSize: processed.length },
    'Image preprocessed'
  );

  return processed;
}

/**
 * Validates incoming image before processing.
 * Returns null if valid, error message string if invalid.
 */
export function validateImage(buffer: Buffer): string | null {
  if (buffer.length > config.images.maxSize) {
    return `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${(config.images.maxSize / 1024 / 1024).toFixed(0)}MB)`;
  }
  // Check for common image magic bytes
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isWebp =
    buffer.length > 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;

  if (!isJpeg && !isPng && !isWebp) {
    return 'Unsupported image format. Send JPEG, PNG, or WebP.';
  }
  return null;
}
