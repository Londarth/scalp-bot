// scripts/signals/orb-breakout.js
// Signal: ORB Breakout — trades WITH the opening range direction.
// This is the anti-fade: wins on trending days where mean-reversion fails.
// Entry: price breaks ORB + holds above/below for 2 bars without reversing.
//
// v1.1: Accepts pre-computed ORB from context.marketContext
//        which the pre-market scan computes once at 9:50 ET.

import { neutral, long, short } from './signal-interface.js';

export const name = 'orb-breakout';
export const version = '1.1.0';

export function analyze(ctx) {
  const { bars, marketContext } = ctx;
  if (!bars || bars.length < 6) return neutral(name, 'insufficient bars');

  // ── Use pre-computed ORB if available (from market-context.json) ──
  let orbHigh, orbLow;
  if (marketContext?.symbols?.[ctx.symbol]?.ob) {
    const ob = marketContext.symbols[ctx.symbol].ob;
    orbHigh = ob.high;
    orbLow = ob.low;
  } else {
    // Fallback: compute ORB from first 3 bars
    const orbBars = bars.slice(0, 3);
    orbHigh = Math.max(...orbBars.map(b => b.high));
    orbLow = Math.min(...orbBars.map(b => b.low));
  }

  const orbRange = orbHigh - orbLow;
  if (orbRange <= 0) return neutral(name, 'flat ORB');

  const recent = bars.slice(-3);
  const current = recent[recent.length - 1];

  // Upside breakout: ≥2 of last 3 bars close above ORB high
  if (recent.filter(b => b.close > orbHigh).length >= 2) {
    const strength = Math.min(1, (current.close - orbHigh) / (orbRange * 0.5));
    return long(name, strength * 0.75, 'ORB upside breakout confirmed',
                { orbHigh: parseFloat(orbHigh.toFixed(2)), orbLow: parseFloat(orbLow.toFixed(2)) });
  }

  // Downside breakout: ≥2 of last 3 bars close below ORB low
  if (recent.filter(b => b.close < orbLow).length >= 2) {
    const strength = Math.min(1, (orbLow - current.close) / (orbRange * 0.5));
    return short(name, strength * 0.75, 'ORB downside breakout confirmed',
                 { orbHigh: parseFloat(orbHigh.toFixed(2)), orbLow: parseFloat(orbLow.toFixed(2)) });
  }

  return neutral(name, `inside ORB (${orbLow.toFixed(2)}-${orbHigh.toFixed(2)})`);
}
