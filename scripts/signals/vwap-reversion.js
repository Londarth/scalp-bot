// scripts/signals/vwap-reversion.js
// Signal: VWAP Mean Reversion — fade extremes from VWAP (>1.5σ)
// when volume profile confirms exhaustion (declining volume).
//
// v1.1: Accepts pre-computed VWAP anchor from market-context.json.
//        Falls back to computing from bars if not available.

import { neutral, long, short } from './signal-interface.js';

export const name = 'vwap-reversion';
export const version = '1.1.0';

export function analyze(ctx) {
  const { bars, dailyATR, marketContext } = ctx;
  if (!bars || bars.length < 10 || !dailyATR) return neutral(name, 'insufficient data');

  let vwap;
  if (marketContext?.symbols?.[ctx.symbol]?.vwap?.anchor) {
    // Use pre-computed VWAP anchor (seeded at 9:50). We update it with
    // incremental bars since then to keep it current.
    vwap = marketContext.symbols[ctx.symbol].vwap.anchor;
    // Recompute VWAP with all bars for accuracy — but use anchor as fallback
    let cumTPV = 0, cumVol = 0;
    for (const b of bars) {
      const tp = (b.high + b.low + b.close) / 3;
      cumTPV += tp * (b.volume || 0);
      cumVol += (b.volume || 0);
    }
    vwap = cumVol > 0 ? cumTPV / cumVol : vwap;
  } else {
    let cumTPV = 0, cumVol = 0;
    for (const b of bars) {
      const tp = (b.high + b.low + b.close) / 3;
      cumTPV += tp * (b.volume || 0);
      cumVol += (b.volume || 0);
    }
    vwap = cumVol > 0 ? cumTPV / cumVol : null;
  }

  if (!vwap) return neutral(name, 'no VWAP');

  const current = bars[bars.length - 1];
  const deviation = (current.close - vwap) / dailyATR;

  const lastThreeVol = bars.slice(-3).map(b => b.volume || 0);
  const volDeclining = lastThreeVol[2] < lastThreeVol[0] * 0.8;

  if (deviation > 1.5 && volDeclining) {
    const strength = Math.min(1, (deviation - 1.5) / 1.5);
    return short(name, strength * 0.8, `overextended above VWAP (${deviation.toFixed(1)}σ)`);
  }

  if (deviation < -1.5 && volDeclining) {
    const strength = Math.min(1, (-deviation - 1.5) / 1.5);
    return long(name, strength * 0.8, `overextended below VWAP (${deviation.toFixed(1)}σ)`);
  }

  return neutral(name, `near VWAP (${deviation.toFixed(1)}σ)`);
}
