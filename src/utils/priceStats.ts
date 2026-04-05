export interface PriceStats {
  min: number;
  max: number;
  avg: number;
}

export function computePriceStats(prices: number[]): PriceStats {
  if (prices.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;

  return { min, max, avg };
}
