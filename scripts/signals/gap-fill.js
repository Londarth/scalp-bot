// scripts/signals/gap-fill.js
// Signal: Gap Fill — stocks gapping >2% from yesterday's close fill ~70%.
// Trade in the fill direction once price starts moving back toward prevClose.
//
// v1.1: Accepts pre-computed gap fill % from market-context.json context.

import { neutral, long, short } from './signal-interface.js';

export const name = 'gap-fill';
export const version = '1.1.0';

function minutesSinceOpen(bars) {
  if (!bars || bars.length === 0) return 0;
  const lastBar = bars[bars.length - 1];
  const ts = new Date(lastBar.ts);
  const h = ts.getHours();
  const m = ts.getMinutes();
  return Math.max(0, (h - 9) * 60 + (m - 30)); // 0930 = 0
}

function timeDecay(bars) {
  const min = minutesSinceOpen(bars);
  if (min > 90) return 0;     // after 11:00: no gap-fill trades
  if (min > 60) return 0.3;  // 10:30–11:00: 70% reduction
  if (min > 30) return 0.7;  // 10:00–10:30: 30% reduction
  return 1.0;                  // first 30 min: full strength
}

export function analyze(ctx) {
  const { bars, prevClose, marketContext } = ctx;
  if (!bars || bars.length < 5 || !prevClose) return neutral(name, 'insufficient data');

  const openPrice = bars[0].open;
  const currentPrice = bars[bars.length - 1].close;
  const gapPct = ((openPrice - prevClose) / prevClose) * 100;
  const absGap = Math.abs(gapPct);

  if (absGap < 2.0) return neutral(name, `gap too small (${gapPct.toFixed(1)}%)`);

  // ── Use pre-computed fill % if available ──
  let filledPct;
  if (marketContext?.symbols?.[ctx.symbol]?.gap?.fillPct != null) {
    // The scan measured fill at 9:50. Adjust for current price movement since.
    const orbClose = marketContext.symbols[ctx.symbol].ob?.close;
    if (orbClose && orbClose !== currentPrice) {
      // Track additional fill since ORB end
      const additionalMove = Math.abs(currentPrice - orbClose);
      const gapSize = Math.abs(prevClose - openPrice);
      const baseFill = marketContext.symbols[ctx.symbol].gap.fillPct;
      const additionalFillPct = gapSize > 0 ? (additionalMove / gapSize) * 100 : 0;
      filledPct = Math.min(baseFill + additionalFillPct, 100);
    } else {
      filledPct = marketContext.symbols[ctx.symbol].gap.fillPct;
    }
    // Convert from absolute fill to directional
    filledPct = gapPct < 0
      ? ((currentPrice - openPrice) / (prevClose - openPrice)) * 100  // gap down
      : ((openPrice - currentPrice) / (openPrice - prevClose)) * 100;  // gap up
  } else {
    // Fallback compute
    if (gapPct < -2.0) {
      filledPct = ((currentPrice - openPrice) / (prevClose - openPrice)) * 100;
    } else {
      filledPct = ((openPrice - currentPrice) / (openPrice - prevClose)) * 100;
    }
  }

  // Gap down → long fill
  if (gapPct < -2.0) {
    if (filledPct < 20) return neutral(name, `gap down (${absGap.toFixed(1)}%), not filling yet (${filledPct.toFixed(0)}%)`);
    const strength = Math.min(1, filledPct / 60) * timeDecay(bars);
    if (strength <= 0) return neutral(name, `gap fill window expired`);
    return long(name, strength, `gap down fill in progress (${absGap.toFixed(1)}% gap, ${filledPct.toFixed(0)}% filled)`);
  }

  // Gap up → short fill
  if (filledPct < 20) return neutral(name, `gap up (${absGap.toFixed(1)}%), not filling yet (${filledPct.toFixed(0)}%)`);
  const strength = Math.min(1, filledPct / 60) * timeDecay(bars);
  if (strength <= 0) return neutral(name, `gap fill window expired`);
  return short(name, strength, `gap up fill in progress (${absGap.toFixed(1)}% gap, ${filledPct.toFixed(0)}% filled)`);
}
