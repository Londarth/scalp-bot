// scripts/signals/volume-surge.js
// Signal: Volume Surge — >3× average volume at a key level
// (prev close, S1, R1, P). Large players defending/attacking zones.
// Direction = candle color relative to the level.

import { neutral, long, short } from './signal-interface.js';

export const name = 'volume-surge';
export const version = '1.0.0';

export function analyze(ctx) {
  const { bars, prevClose, pivots, dailyATR } = ctx;
  if (!bars || bars.length < 10 || !prevClose || !pivots || !dailyATR)
    return neutral(name, 'insufficient data');

  const current = bars[bars.length - 1];
  const currentVol = current.volume || 0;

  const avgVol = bars.slice(-10, -1).reduce((s, b) => s + (b.volume || 0), 0) / 9;
  if (avgVol < 1) return neutral(name, 'no volume data');

  const volRatio = currentVol / avgVol;
  if (volRatio < 3.0) return neutral(name, `normal volume (${volRatio.toFixed(1)}x)`);

  const keyLevels = [
    { name: `PrevClose $${prevClose.toFixed(2)}`, price: prevClose },
    { name: `S1 $${pivots.S1.toFixed(2)}`, price: pivots.S1 },
    { name: `R1 $${pivots.R1.toFixed(2)}`, price: pivots.R1 },
    { name: `P $${pivots.P.toFixed(2)}`, price: pivots.P },
  ];

  let closest = null, closestDist = Infinity;
  for (const level of keyLevels) {
    const dist = Math.abs(current.close - level.price) / dailyATR;
    if (dist < 0.3 && dist < closestDist) { closest = level; closestDist = dist; }
  }

  if (!closest) return neutral(name, `volume surge but no key level nearby (${volRatio.toFixed(1)}x)`);

  const surgedAbove = current.close > closest.price && current.open < closest.price;
  const surgedBelow = current.close < closest.price && current.open > closest.price;
  const strength = Math.min(1, (volRatio - 3) / 4);

  if (surgedAbove) return long(name, strength, `volume surge (${volRatio.toFixed(1)}x) above ${closest.name}`);
  if (surgedBelow) return short(name, strength, `volume surge (${volRatio.toFixed(1)}x) below ${closest.name}`);

  return neutral(name, `volume surge (${volRatio.toFixed(1)}x) ambiguous at ${closest.name}`);
}
