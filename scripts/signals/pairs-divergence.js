// scripts/signals/pairs-divergence.js
// Signal: Pairs Divergence — trade cointegrated pair spread reversions.
// Pre-defined pairs from the universe. When spread >2σ, fade divergence.
//
// v1.1: Accepts correlation matrix hints from market-context.json.
//        Prioritizes pairs with strong recent correlation. Skips pairs
//        where one leg is in the 'skip' tier (dead stock).

import { neutral, long, short } from './signal-interface.js';

export const name = 'pairs-divergence';
export const version = '1.1.0';

const PAIRS = [
  { a: 'MARA', b: 'CLSK', hedgeRatio: 1.1 },   // crypto miners
  { a: 'SOFI', b: 'LCID', hedgeRatio: 2.5 },    // high-beta retail
  { a: 'PLTR', b: 'IONQ', hedgeRatio: 0.3 },     // tech momentum
  { a: 'DKNG', b: 'SOFI', hedgeRatio: 1.2 },     // consumer/leisure
  { a: 'SMR', b: 'UEC', hedgeRatio: 1.0 },        // nuclear/uranium
  { a: 'BTDR', b: 'MARA', hedgeRatio: 1.0 },      // crypto adjacent
];

const spreadHistory = new Map();

export function analyze(ctx) {
  const { symbol, price, dailyATR, pairData, marketContext } = ctx;
  if (!pairData || !dailyATR) return neutral(name, 'no pair data');

  const pairDef = PAIRS.find(p => p.a === symbol || p.b === symbol);
  if (!pairDef) return neutral(name, `no pair for ${symbol}`);

  // ── Check if any leg is in skip tier ──
  if (marketContext?.symbols) {
    const myTier = marketContext.symbols[symbol]?.opportunity?.tier;
    const otherSym = pairDef.a === symbol ? pairDef.b : pairDef.a;
    const otherTier = marketContext.symbols[otherSym]?.opportunity?.tier;

    if (myTier === 'skip' || otherTier === 'skip') {
      return neutral(name, `pair ${symbol}-${otherSym}: one leg in skip tier`);
    }

    // ── Correlation quality check ──
    const corr = marketContext.correlationMatrix?.[symbol]?.[otherSym];
    if (corr !== undefined && Math.abs(corr) < 0.3) {
      return neutral(name, `${symbol}-${otherSym}: correlation too weak (${corr.toFixed(2)})`);
    }
  }

  const isA = pairDef.a === symbol;
  const otherPrice = pairData.prices?.[isA ? pairDef.b : pairDef.a];
  if (!otherPrice) return neutral(name, `no price for ${isA ? pairDef.b : pairDef.a}`);

  let rawSpread;
  if (isA) rawSpread = price - pairDef.hedgeRatio * otherPrice;
  else rawSpread = price - otherPrice / pairDef.hedgeRatio;

  const pairKey = `${pairDef.a}-${pairDef.b}`;
  if (!spreadHistory.has(pairKey)) spreadHistory.set(pairKey, []);
  const history = spreadHistory.get(pairKey);
  history.push({ spread: rawSpread, ts: Date.now() });
  if (history.length > 50) history.shift();
  if (history.length < 10) return neutral(name, 'insufficient spread history');

  const spreads = history.map(h => h.spread);
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const variance = spreads.reduce((s, v) => s + (v - mean) ** 2, 0) / spreads.length;
  const stdev = Math.sqrt(variance);
  if (stdev < 0.001) return neutral(name, 'spread too tight');

  const zScore = (rawSpread - mean) / stdev;
  const absZ = Math.abs(zScore);
  if (absZ < 2.0) return neutral(name, `spread at ${zScore.toFixed(1)}σ`);

  const strength = Math.min(1, (absZ - 2) / 2); // 2-4σ → 0-1

  if (zScore > 2)
    return short(name, strength * 0.7, `pair divergence: overvalued vs ${isA ? pairDef.b : pairDef.a} (${zScore.toFixed(1)}σ)`);
  return long(name, strength * 0.7, `pair divergence: undervalued vs ${isA ? pairDef.b : pairDef.a} (${zScore.toFixed(1)}σ)`);
}
