// scripts/lib/scanner.js
// Shared scanner logic for pre-market scan and Helios context generation.
//
// v2.0: Added opportunityScore() for Helios-aware ranking and
//        computeATRExpansion() for volatility regime detection.

export const DEFAULT_WEIGHTS = { rvol: 0.20, atrPct: 0.30, gapPct: 0.15, rangeAtrRatio: 0.35 };

export const DEFAULT_FILTERS = {
  minPrice: 2,
  maxPrice: 100,
  minATR: 0.50,
  minATRPct: 1.5,
  maxATRPct: 8.0,
  minGapPct: 0,       // zero gap is fine for T&T (range matters, not gap)
  maxGapPct: 15,       // extreme gaps = exhaustion risk
  atrPctThreshold: 0.25,
};

// Filter a single candidate. Returns { passed, reason }.
export function filterCandidate({ symbol, dailyATR, price, prevClose, openPrice, rangeHigh, rangeLow, rangeOpen, rangeClose }, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const range = rangeHigh - rangeLow;

  if (price < f.minPrice) return { passed: false, reason: `price $${price.toFixed(2)} < $${f.minPrice}` };
  if (price > f.maxPrice) return { passed: false, reason: `price $${price.toFixed(2)} > $${f.maxPrice}` };
  if (!dailyATR || dailyATR < f.minATR) return { passed: false, reason: `ATR $${dailyATR?.toFixed(2) ?? 'N/A'} < $${f.minATR}` };

  const atrPct = dailyATR / price * 100;
  if (atrPct < f.minATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% < ${f.minATRPct}%` };
  if (atrPct > f.maxATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% > ${f.maxATRPct}%` };

  if (prevClose !== null && prevClose > 0) {
    const gapPct = Math.abs(openPrice - prevClose) / prevClose * 100;
    if (gapPct > f.maxGapPct) return { passed: false, reason: `gap ${gapPct.toFixed(1)}% > ${f.maxGapPct}%` };
  }

  if (range < dailyATR * f.atrPctThreshold) return { passed: false, reason: `range $${range.toFixed(2)} < ${f.atrPctThreshold * 100}% of ATR` };

  const isRed = rangeClose < rangeOpen;
  const isGreen = rangeClose > rangeOpen;
  if (!isRed && !isGreen) return { passed: false, reason: 'doji opening candle' };

  return { passed: true, reason: `${isRed ? 'RED→LONG' : 'GREEN→SHORT'}` };
}

// ─── Pivot-specific microstructure filters ───

export const DEFAULT_PIVOT_FILTERS = {
  minPrice: 3,
  maxPrice: 60,
  maxAvgVolume: 5_000_000,  // 5M shares daily — filters out very liquid names
  minATRPct: 4.0,             // KEY GATE: all 4 winners have ATR% >= 4.0%
  maxATRPct: 10.0,            // too volatile = noise, not structure
};

export function filterMicrostructure({ avgVolume, atrPct, price }, filters = DEFAULT_PIVOT_FILTERS) {
  const f = { ...DEFAULT_PIVOT_FILTERS, ...filters };

  if (avgVolume > f.maxAvgVolume) return { passed: false, reason: `avg volume ${avgVolume.toLocaleString()} > ${f.maxAvgVolume.toLocaleString()}` };
  if (atrPct < f.minATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% < ${f.minATRPct}%` };
  if (atrPct > f.maxATRPct) return { passed: false, reason: `ATR% ${atrPct.toFixed(1)}% > ${f.maxATRPct}%` };
  if (price < f.minPrice) return { passed: false, reason: `price $${price.toFixed(2)} < $${f.minPrice}` };
  if (price > f.maxPrice) return { passed: false, reason: `price $${price.toFixed(2)} > $${f.maxPrice}` };

  return { passed: true, reason: 'pivot-suitable' };
}

// Rank candidates by composite score. Each factor is normalized to 0-100 within the group.
export function rankCandidates(candidates, weights = DEFAULT_WEIGHTS) {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    const scored = [{ ...candidates[0], score: 100 }];
    return scored;
  }

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const keys = Object.keys(w);

  // Clone candidates so we don't mutate caller's data
  const scored = candidates.map(c => ({ ...c }));

  // Normalize each metric to 0-100 rank
  for (const key of keys) {
    const values = scored.map(c => c[key] ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    for (const c of scored) {
      c[`_${key}Rank`] = ((c[key] ?? 0) - min) / range * 100;
    }
  }

  for (const c of scored) {
    c.score = keys.reduce((sum, key) => sum + w[key] * (c[`_${key}Rank`] ?? 0), 0);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ─── Helios-specific: Volatility Regime ──────────────────────────────

/**
 * Compute ATR expansion/contraction ratio.
 * Compares today's estimated intraday vol to the 14-day historical ATR.
 *
 * @param {number} orbRange — today's opening range (high - low)
 * @param {number} dailyATR — 14-period daily ATR
 * @param {number} historicalAvg — optional: average daily range over 14 days
 * @returns {{ ratio: number, regime: 'compressing'|'normal'|'expanding', label: string }}
 *
 * Interpretation:
 *   ratio < 0.8  → compressing → coiled springs, breakouts more likely
 *   ratio 0.8-1.3 → normal range
 *   ratio > 1.3  → expanding → wide swings, reduce size
 */
export function computeATRExpansion(orbRange, dailyATR, historicalAvg = null) {
  if (!dailyATR || dailyATR <= 0) {
    return { ratio: 1.0, regime: 'normal', label: 'ATR n/a' };
  }

  // Normalized: today's per-bar range vs expected per-bar range
  // orbRange covers ~3 × 5-min bars. Historical ATR is daily.
  // Approximate: daily ATR ≈ 4× typical 15-min range, so orbRange / 0.25 ATR
  const ratio = (orbRange / dailyATR) / 0.35; // 0.35 ≈ expected fraction of daily ATR in 3 bars

  let regime, label;
  if (ratio < 0.8) {
    regime = 'compressing';
    label = `compressing (${(ratio * 100).toFixed(0)}%) — breakout likely`;
  } else if (ratio > 1.3) {
    regime = 'expanding';
    label = `expanding (${(ratio * 100).toFixed(0)}%) — reduce size`;
  } else {
    regime = 'normal';
    label = `normal (${(ratio * 100).toFixed(0)}%)`;
  }

  return { ratio: parseFloat(ratio.toFixed(3)), regime, label };
}

// ─── Helios-specific: Opportunity Score ──────────────────────────────

/**
 * Compute a Helios-aware opportunity score for a symbol.
 * This replaces the old T&T "side/entry" format with a signal-agnostic
 * measure of how "tradable" this stock is today.
 *
 * Factors (equal-weighted):
 *   1. range/ATR ratio — how much movement in the ORB
 *   2. rvol — relative volume vs historical (liquidity)
 *   3. gap magnitude — larger gaps = more fill opportunity
 *   4. atrPct — how volatile is the stock
 *   5. directional clarity — did the ORB move decisively one way?
 *
 * @returns {{ score: number, tier: 'full'|'light'|'skip', components: {} }}
 */
export function opportunityScore({
  rangeHigh, rangeLow, rangeOpen, rangeClose,
  dailyATR, price, prevClose, rvol, atrPct, gapPct, rangeATRRatio,
}) {
  // 1. Range/ATR: 25-100% → good; <25% → dead; >100% → wild
  const rarScore = Math.min(1, Math.max(0, (rangeATRRatio - 0.2) / 0.75));

  // 2. rvol: 1.0 → normal; 2.0+ → very active; <0.5 → dead
  const rvolScore = Math.min(1, Math.max(0, (rvol - 0.5) / 2.0));

  // 3. gapPct: 0 → 0.1; 3%+ → 1.0 (gap-fill potential)
  const gapScore = Math.min(1, gapPct / 3.0);

  // 4. atrPct: 2% → 0.3; 5%+ → 1.0
  const atrScore = Math.min(1, Math.max(0, (atrPct - 1.5) / 4.0));

  // 5. Directional clarity: did it close decisively one way from open?
  const movePct = rangeOpen > 0 ? Math.abs(rangeClose - rangeOpen) / rangeOpen : 0;
  const dirScore = Math.min(1, movePct / 0.015); // 1.5% directional move = max

  // Composite (all equal weight)
  const score = (rarScore * 0.25 + rvolScore * 0.20 + gapScore * 0.15 + atrScore * 0.20 + dirScore * 0.20) * 100;

  // Tier assignment
  let tier;
  if (score >= 55) tier = 'full';
  else if (score >= 30) tier = 'light';
  else tier = 'skip';

  return {
    score: parseFloat(score.toFixed(1)),
    tier,
    components: {
      rarScore: parseFloat(rarScore.toFixed(3)),
      rvolScore: parseFloat(rvolScore.toFixed(3)),
      gapScore: parseFloat(gapScore.toFixed(3)),
      atrScore: parseFloat(atrScore.toFixed(3)),
      dirScore: parseFloat(dirScore.toFixed(3)),
    },
  };
}

// ─── Pairs: Compute pairwise correlations ────────────────────────────

/**
 * Compute a simple correlation matrix from an array of daily returns.
 * @param {{string, number[]}} returns — sym → array of daily returns (%)
 * @returns {{string, {string, number}}} — sym → { sym → correlation }
 */
export function computeCorrelationMatrix(returns, minBars = 15) {
  const symbols = Object.keys(returns).filter(s => returns[s].length >= minBars);
  const matrix = {};

  for (const s1 of symbols) {
    matrix[s1] = {};
    const r1 = returns[s1].slice(-minBars);

    for (const s2 of symbols) {
      if (s1 === s2) { matrix[s1][s2] = 1.0; continue; }
      const r2 = returns[s2].slice(-minBars);

      // Pearson correlation
      const n = Math.min(r1.length, r2.length);
      let sum1 = 0, sum2 = 0, sum11 = 0, sum22 = 0, sum12 = 0;
      for (let i = 0; i < n; i++) {
        const a = r1[i], b = r2[i];
        sum1 += a; sum2 += b;
        sum11 += a * a; sum22 += b * b; sum12 += a * b;
      }
      const num = n * sum12 - sum1 * sum2;
      const den = Math.sqrt((n * sum11 - sum1 * sum1) * (n * sum22 - sum2 * sum2));
      matrix[s1][s2] = den > 0 ? parseFloat((num / den).toFixed(3)) : 0;
    }
  }
  return matrix;
}
