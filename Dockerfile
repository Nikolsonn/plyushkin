# -- build stage --
FROM node:22-slim AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ src/
RUN npx --no-install tsc

# -- production stage --
FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-lav \
      tesseract-ocr-eng && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist/ dist/

RUN mkdir -p data/images

VOLUME /app/data

ENV NODE_ENV=production \
    OCR_ENGINE=native \
    API_PORT=3000

EXPOSE 3000

CMD ["node", "--max-old-space-size=180", "--optimize-for-size", "dist/main.js"]
