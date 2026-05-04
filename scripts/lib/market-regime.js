// scripts/lib/market-regime.js
// Market regime detection: classifies current state as trending or ranging.
// Used by Helios to filter trade directions and adjust entry criteria.
//
// v1.1: Added classifyFromBars() — a pure function that works with
//        pre-fetched bars so the pre-market scan can run it without
//        duplicating network calls. Also added classifyFromContext()
//        which accepts the market-context.json structure.
//
// Regime classification:
//   trending_up   — making higher highs, OB above VWAP, price > ORB high
//   trending_down — making lower lows, OB below VWAP, price < ORB low
//   chop/ranging  — price oscillating within ORB, near VWAP
//
// Entry filter logic:
//   trending_up   → only take LONG entries (don't fight the trend)
//   trending_down → only take SHORT entries
//   chop/ranging  → take both directions (mean-reversion works here)

import { retry } from './retry.js';
import { getTodayStr } from './time.js';

let cachedRegime = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60000; // 1-minute cache to avoid hammering API

// ─── Exported entry point: fetch SPY bars live ───────────────────────
//
// This is the dynamic version — calls Alpaca live. Used by detectRegime()
// during bot runtime when market conditions change minute-to-minute.

export async function detectRegime({ forceRefresh = false } = {}) {
  if (cachedRegime && (Date.now() - cacheTime < CACHE_TTL_MS) && !forceRefresh) {
    return cachedRegime;
  }

  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
  const today = getTodayStr();

  try {
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=5Min&start=${today}T09:25:00-04:00&end=${today}T16:30:00-04:00&limit=78&feed=iex`;
    const resp = await retry(() => fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    }));
    if (!resp.ok) throw new Error(`SPY fetch ${resp.status}`);
    const data = await resp.json();
    const bars = (data.bars?.SPY || []).map(b => ({
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, ts: b.t,
    }));

    const regime = classifyFromBars(bars);
    cachedRegime = regime;
    cacheTime = Date.now();
    return regime;
  } catch (e) {
    return {
      regime: 'unknown',
      spyDirection: 'neutral',
      allowedDirections: ['long', 'short'],
      metrics: { error: e.message },
    };
  }
}

// ─── Pure function: classify regime from raw bars ────────────────────
//
// This is the workhorse. It accepts an array of normalized bar objects
// and returns the full regime structure. The pre-market scan calls this
// once at 9:50 and passes the result to Helios as a prior.
//
// @param {Array<{open, high, low, close, volume, ts}>} bars
// @returns {{ regime, spyDirection, allowedDirections, metrics }}

export function classifyFromBars(bars) {
  if (!bars || bars.length < 5) {
    return {
      regime: 'unknown', spyDirection: 'neutral',
      allowedDirections: ['long', 'short'], metrics: {},
    };
  }

  // ── Compute ORB (first 3 bars) ──
  const orbBars = bars.slice(0, Math.min(3, bars.length));
  const orbHigh = Math.max(...orbBars.map(b => b.high));
  const orbLow = Math.min(...orbBars.map(b => b.low));
  const orbRange = orbHigh - orbLow;
  const orbOpen = orbBars[0].open;
  const orbClose = orbBars[orbBars.length - 1].close;
  const orbIsGreen = orbClose > orbOpen;

  // ── Current state ──
  const current = bars[bars.length - 1];
  const currentPrice = current.close;

  // ── Compute VWAP on all bars ──
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * (b.volume || 0);
    cumVol += (b.volume || 0);
  }
  const vwap = cumVol > 0 ? cumTPV / cumVol : currentPrice;

  // ── ATR estimate ──
  const estimatedATR = orbRange > 0 ? orbRange : currentPrice * 0.005;

  // ── Regime signals ──
  const aboveVWAP = currentPrice > vwap * 1.001;
  const belowVWAP = currentPrice < vwap * 0.999;
  const aboveOrbHigh = currentPrice > orbHigh;
  const belowOrbLow = currentPrice < orbLow;
  const insideOrb = currentPrice >= orbLow && currentPrice <= orbHigh;

  // ── Directional momentum ──
  const recentBars = bars.slice(-Math.min(3, bars.length));
  const momentum = recentBars[recentBars.length - 1].close - recentBars[0].open;
  const upwardMomentum = momentum > estimatedATR * 0.15;
  const downwardMomentum = momentum < -estimatedATR * 0.15;

  // ── Distance from ORB (in ATR units) ──
  const distFromOrbHigh = (currentPrice - orbHigh) / estimatedATR;
  const distFromOrbLow = (orbLow - currentPrice) / estimatedATR;

  // ── Classification ──
  let regime = 'chop';
  let spyDirection = 'neutral';
  let allowedDirections = ['long', 'short'];

  if (aboveOrbHigh && aboveVWAP && upwardMomentum && distFromOrbHigh > 0.3) {
    regime = 'trending_up';
    spyDirection = 'green';
    allowedDirections = ['long'];
  } else if (belowOrbLow && belowVWAP && downwardMomentum && distFromOrbLow > 0.3) {
    regime = 'trending_down';
    spyDirection = 'red';
    allowedDirections = ['short'];
  } else if (insideOrb || (Math.abs(distFromOrbHigh) < 0.5 && Math.abs(distFromOrbLow) < 0.5)) {
    regime = 'chop';
    spyDirection = orbIsGreen ? 'green' : 'red';
    allowedDirections = ['long', 'short'];
  } else {
    regime = 'chop';
    spyDirection = aboveVWAP ? 'green' : belowVWAP ? 'red' : 'neutral';
    allowedDirections = ['long', 'short'];
  }

  return {
    regime,
    spyDirection,
    allowedDirections,
    metrics: {
      orbHigh: parseFloat(orbHigh.toFixed(2)),
      orbLow: parseFloat(orbLow.toFixed(2)),
      orbRange: parseFloat(orbRange.toFixed(2)),
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      vwap: parseFloat(vwap.toFixed(2)),
      distFromOrbHigh: parseFloat(distFromOrbHigh.toFixed(3)),
      distFromOrbLow: parseFloat(distFromOrbLow.toFixed(3)),
      orbIsGreen,
      aboveVWAP, belowVWAP, aboveOrbHigh, belowOrbLow, insideOrb,
      upwardMomentum, downwardMomentum,
      barCount: bars.length,
    },
  };
}

// ─── Quick helpers ───────────────────────────────────────────────────

/**
 * Quick check: should we allow this entry direction given the current regime?
 */
export async function isDirectionAllowed(side) {
  const { regime, allowedDirections, metrics } = await detectRegime();

  if (regime === 'unknown') {
    return { allowed: true, reason: 'regime unknown — permitting' };
  }

  if (!allowedDirections.includes(side)) {
    const direction = side === 'long' ? 'up' : 'down';
    return {
      allowed: false,
      reason: `market trending ${direction}, ${side} entries blocked`,
    };
  }

  return { allowed: true, reason: `${regime} regime, ${side} allowed` };
}

/**
 * Entry sizing multiplier based on regime confidence.
 * Chop → full size (1.0). Trending → 0.75 (higher risk of continuation).
 */
export function regimeSizeMultiplier(regimeObj) {
  if (!regimeObj) return 1.0;
  switch (regimeObj.regime) {
    case 'trending_up':
    case 'trending_down':
      return 0.75;
    case 'chop':
      return 1.0;
    default:
      return 1.0;
  }
}

/**
 * For pivot bot: regime confidence affects minRR requirement.
 * Chop → standard minRR. Trending → require 20% higher RR.
 */
export function regimeMinRRMultiplier(regimeObj) {
  if (!regimeObj) return 1.0;
  switch (regimeObj.regime) {
    case 'trending_up':
    case 'trending_down':
      return 1.2; // 20% stricter
    default:
      return 1.0;
  }
}
