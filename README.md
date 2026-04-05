# Receipt Price Tracker

A production-ready backend service for Raspberry Pi 3 that extracts product prices from receipt photos sent via Telegram and stores price history in SQLite.

## Architecture

```
┌──────────────┐     ┌──────────────────────────────────────────────────┐
│  Telegram     │     │  Raspberry Pi 3                                  │
│  (user sends  │────▶│                                                  │
│   receipt     │     │  ┌─────────┐  ┌────────────┐  ┌──────────────┐  │
│   photo)      │     │  │Telegram │  │  Image      │  │  Tesseract   │  │
│               │◀────│  │Bot      │─▶│  Preprocess │─▶│  OCR         │  │
│               │     │  │(polling)│  │  (sharp)    │  │  (native)    │  │
│               │     │  └─────────┘  └────────────┘  └──────┬───────┘  │
│               │     │                                       │          │
│               │     │  ┌─────────┐  ┌────────────┐  ┌──────▼───────┐  │
│               │     │  │Fastify  │  │  SQLite     │◀─│  Receipt     │  │
│               │     │  │REST API │─▶│  (Drizzle)  │  │  Parser      │  │
│               │     │  │:3000    │  │  WAL mode   │  │  + Normalizer│  │
│               │     │  └─────────┘  └────────────┘  └──────────────┘  │
│               │     │                                                  │
└──────────────┘     └──────────────────────────────────────────────────┘
```

## Processing Pipeline

```
Photo ─▶ Download ─▶ Resize to 800px ─▶ Grayscale ─▶ Normalize contrast
         (Telegram     (sharp)            (sharp)      (sharp)
          Bot API)

     ─▶ OCR ─▶ Parse lines ─▶ Detect store ─▶ Normalize names
        (tesseract   (regex)      (fuzzy        (remove accents,
         native)                   keyword       units, numbers)
                                   match)

     ─▶ Deduplicate ─▶ Store in SQLite
        (Levenshtein)   (Drizzle ORM)
```

## Design Decisions

### OCR Engine: Native Tesseract (recommended) vs Tesseract.js

| Metric              | Native Tesseract       | Tesseract.js           |
|---------------------|------------------------|------------------------|
| Speed (RPi 3)       | ~3-5s per receipt      | ~30-60s per receipt    |
| Memory              | ~50MB peak             | ~150MB+ (WASM)        |
| Dependencies        | System package         | None (bundled WASM)    |
| ARM support         | Native ARM binary      | WASM (emulated)        |

Native Tesseract is 10-14x faster because it runs as a compiled ARM binary.
Tesseract.js runs Tesseract compiled to WebAssembly, which adds significant overhead on ARM.

Set `OCR_ENGINE=native` (default) or `OCR_ENGINE=tesseractjs` in `.env`.

### ORM: Drizzle over Prisma

- **12KB** runtime vs Prisma's 1.6MB — critical for RPi 3 with 1GB RAM
- No code generation step (`prisma generate`)
- No binary dependencies — Prisma ships platform-specific binaries
- SQL-first API with full TypeScript type safety
- `better-sqlite3` is synchronous, avoiding event-loop overhead for simple queries

### Database: SQLite with WAL mode

- No separate database server process (saves ~50MB RAM)
- WAL mode enables concurrent reads during writes
- Single-file database, trivial to back up (`cp data/receipt-tracker.db backup.db`)
- Indexes on `product_id`, `receipt_id`, `normalized_name`, `store`, `datetime`

### Telegram: Long-polling over webhooks

- No public IP or port forwarding needed
- Works behind NAT/router out of the box
- 2-second polling interval — gentle on CPU, acceptable latency

### Image preprocessing: The single biggest optimization

Resizing receipt photos from typical camera resolution (3000-4600px wide) down to 800px
is THE critical optimization. It reduces OCR time by 10x+ because Tesseract processes
far fewer pixels. Receipt text remains readable at 800px.

### Processing lock

Only one receipt is processed at a time. The RPi 3 has 1GB RAM and a quad-core
Cortex-A53 — running parallel OCR would exceed memory limits and thrash the CPU.
Subsequent photos are queued with a "please wait" message.

## Performance Budget

| Metric                  | Target      | Achieved           |
|-------------------------|-------------|--------------------|
| Memory (idle)           | < 200MB     | ~60-80MB           |
| Memory (during OCR)     | < 200MB     | ~120-150MB         |
| Idle CPU                | < 5%        | < 2% (polling)     |
| OCR CPU                 | < 80% core  | ~60-70% (native)   |
| Processing time         | < 5s        | ~3-5s (native)     |
| Max image size          | 3MB         | 3MB (configurable) |

## Project Structure

```
src/
├── main.ts                    # Entry point, env loading, graceful shutdown
├── config.ts                  # Centralized configuration from env vars
├── bot/
│   └── telegramBot.ts         # Telegram bot: commands, photo handler
├── ocr/
│   └── ocrService.ts          # OCR: native Tesseract + Tesseract.js engines
├── parser/
│   ├── receiptParser.ts       # Extract product lines from OCR text
│   ├── storeDetector.ts       # Identify store from receipt header
│   └── productNormalizer.ts   # Normalize product names for dedup
├── database/
│   ├── schema.ts              # Drizzle schema (receipts, products, items)
│   ├── db.ts                  # SQLite connection, migrations, WAL config
│   └── migrate.ts             # Standalone migration script
├── services/
│   ├── receiptService.ts      # Pipeline orchestrator + query helpers
│   ├── productService.ts      # Product catalog, resolve + dedup
│   └── deduplicationService.ts # Levenshtein similarity matching
├── api/
│   ├── server.ts              # Fastify server setup
│   └── routes.ts              # REST API endpoints
└── utils/
    ├── logger.ts              # Pino logger
    └── imagePreprocess.ts     # Sharp: resize, grayscale, contrast
```

## REST API

| Endpoint                    | Method | Description              |
|-----------------------------|--------|--------------------------|
| `/health`                   | GET    | Health check             |
| `/products`                 | GET    | List products (?q=search)|
| `/products/:name/prices`    | GET    | Price history            |
| `/stores`                   | GET    | List detected stores     |
| `/stats`                    | GET    | Purchase statistics      |
| `/receipts`                 | GET    | List receipts (?limit=N) |

### Examples

```bash
# Health check
curl http://raspberrypi:3000/health

# List all products
curl http://raspberrypi:3000/products

# Search products
curl http://raspberrypi:3000/products?q=piens

# Price history for bananas
curl http://raspberrypi:3000/products/banani/prices

# Statistics
curl http://raspberrypi:3000/stats

# Stores
curl http://raspberrypi:3000/stores

# Recent receipts
curl http://raspberrypi:3000/receipts?limit=10
```

## Telegram Bot Commands

| Command             | Description                  |
|---------------------|------------------------------|
| `/start`            | Welcome message              |
| `/stats`            | Purchase statistics          |
| `/prices <product>` | Price history for a product  |
| `/help`             | List available commands      |
| Send a photo        | Process receipt              |

## Installation

### 1. Prerequisites (Raspberry Pi OS)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS (ARM)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install native Tesseract OCR (STRONGLY recommended for performance)
sudo apt install -y tesseract-ocr tesseract-ocr-lav tesseract-ocr-eng

# Verify
node --version    # v20.x
tesseract --version  # tesseract 5.x
```

### 2. Project Setup

```bash
# Clone or copy project
cd /home/pi
git clone <your-repo-url> receipt-tracker
cd receipt-tracker

# Install Node.js dependencies
npm install

# Create data directories
mkdir -p data/images

# Configure environment
cp .env.example .env
nano .env
# Set TELEGRAM_BOT_TOKEN (get from @BotFather)
# Set OCR_ENGINE=native (recommended)
```

### 3. Create Telegram Bot

1. Open Telegram, find `@BotFather`
2. Send `/newbot`
3. Choose a name and username
4. Copy the token to `.env` as `TELEGRAM_BOT_TOKEN`

### 4. Build and Run

```bash
# Build TypeScript
npm run build

# Start the server
npm start
```

### 5. System Optimization (Optional)

```bash
# Reduce GPU memory allocation (more RAM for Node.js)
echo "gpu_mem=16" | sudo tee -a /boot/config.txt

# Create RAM disk for OCR temp files (reduces SD card wear)
echo "tmpfs /tmp/ocr tmpfs defaults,size=64M 0 0" | sudo tee -a /etc/fstab
sudo mount -a

# Set CPU governor to performance (faster OCR, higher power)
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

## Autostart with systemd

```bash
# Copy service file
sudo cp receipt-tracker.service /etc/systemd/system/

# Edit paths if needed (default assumes /home/pi/receipt-tracker)
sudo nano /etc/systemd/system/receipt-tracker.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable receipt-tracker
sudo systemctl start receipt-tracker

# Check status
sudo systemctl status receipt-tracker

# View logs
journalctl -u receipt-tracker -f

# Restart after changes
sudo systemctl restart receipt-tracker
```

## OCR Improvement Strategies

### Image Preprocessing (implemented)

- **Resize to 800px width** — The single most impactful optimization. Reduces pixel count by 90%+ while keeping receipt text readable.
- **Grayscale** — Removes color channels, reduces data by 3x.
- **Normalize contrast** — Auto-adjusts brightness/contrast to maximize text-background separation.
- **Sharpen** — Recovers edge detail after downscaling.

### Tesseract Configuration (implemented)

- **OEM 1** (LSTM) — Neural network engine, best accuracy for modern receipts.
- **PSM 6** — Assumes a single uniform block of text, ideal for receipts.
- **OMP_THREAD_LIMIT=2** — Limits Tesseract threads to 2 cores, leaving 2 for Node.js and system.

### Language Data

- Install language-specific data: `tesseract-ocr-lav` for Latvian, `tesseract-ocr-eng` for English.
- Multi-language: `TESSERACT_LANG=lav+eng` processes with both models.

### Advanced (not implemented, future ideas)

- **Deskew** — Straighten rotated receipts. Requires additional image analysis.
- **Adaptive thresholding** — Better binarization for photos with uneven lighting.
- **Custom Tesseract training** — Train on Latvian receipt fonts for higher accuracy.
- **Receipt-specific whitelist** — Restrict character set to expected characters.

## Stores Supported

| Store    | Detection Method                           |
|----------|--------------------------------------------|
| Rimi     | Header keywords, fuzzy OCR pattern         |
| Maxima   | Header keywords, fuzzy OCR pattern         |
| Lidl     | Header keywords, fuzzy OCR pattern         |
| Coop     | Header keywords, fuzzy OCR pattern         |
| Top!     | Header keywords, fuzzy OCR pattern         |
| Depo     | Header keywords, fuzzy OCR pattern         |
| Mego     | Header keywords, fuzzy OCR pattern         |
| Citro    | Header keywords, fuzzy OCR pattern         |

Adding a new store: add an entry to `STORES` array in `src/parser/storeDetector.ts`.

## Error Handling

| Scenario                    | Behavior                                        |
|-----------------------------|-------------------------------------------------|
| OCR returns no text         | Error message to Telegram user                  |
| No products found           | Error with suggestion to improve photo quality   |
| Tesseract not installed     | Clear error message with install instructions    |
| Image too large             | Rejected with size limit info                    |
| Invalid image format        | Rejected with supported formats list             |
| Database error              | Logged, error returned to user                   |
| Telegram API failure        | Logged, polling auto-retries                     |
| Concurrent receipt          | "Please wait" message, sequential processing     |
| Uncaught exception          | Logged as fatal, graceful shutdown               |

## Backup

```bash
# Simple file copy (SQLite is a single file)
cp data/receipt-tracker.db backups/receipt-tracker-$(date +%Y%m%d).db

# Or use SQLite backup API
sqlite3 data/receipt-tracker.db ".backup backups/receipt-tracker-$(date +%Y%m%d).db"
```

## License

MIT
