// scripts/signals/momentum-cascade.js
// Signal: Momentum Cascade — multi-timeframe RSI alignment.
// Fast (RSI-3), medium (RSI-7), slow (RSI-14) all pointing same way → ride the wave.

import { neutral, long, short } from './signal-interface.js';

export const name = 'momentum-cascade';
export const version = '1.0.0';

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  if (gains + losses === 0) return 50;
  return 100 - 100 / (1 + gains / (losses || 1));
}

function slope(values) {
  if (values.length < 3) return 0;
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? num / den : 0;
}

export function analyze(ctx) {
  const { bars } = ctx;
  if (!bars || bars.length < 20) return neutral(name, 'insufficient bars');

  const closes = bars.map(b => b.close);
  const rsi3 = rsi(closes, 3);
  const rsi7 = rsi(closes, 7);
  const rsi14 = rsi(closes, 14);
  if (!rsi3 || !rsi7 || !rsi14) return neutral(name, 'RSI not ready');

  const rsi3Recent = closes.slice(-6)
    .map((_, i, arr) => rsi(arr.slice(0, i + 4), 3))
    .filter(v => v !== null);
  const rsi3Slope = slope(rsi3Recent);

  const allBullish = rsi3 > 60 && rsi7 > 55 && rsi14 > 50 && rsi3Slope > 0.5;
  const allBearish = rsi3 < 40 && rsi7 < 45 && rsi14 < 50 && rsi3Slope < -0.5;

  if (allBullish)
    return long(name, Math.min(1, (rsi3 - 60) / 20),
      `cascade LONG: RSI3=${rsi3.toFixed(0)} RSI7=${rsi7.toFixed(0)} RSI14=${rsi14.toFixed(0)}`);

  if (allBearish)
    return short(name, Math.min(1, (40 - rsi3) / 20),
      `cascade SHORT: RSI3=${rsi3.toFixed(0)} RSI7=${rsi7.toFixed(0)} RSI14=${rsi14.toFixed(0)}`);

  return neutral(name, `mixed: RSI3=${rsi3.toFixed(0)} RSI7=${rsi7.toFixed(0)} RSI14=${rsi14.toFixed(0)}`);
}
