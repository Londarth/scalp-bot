#!/usr/bin/env node
// Pre-market scanner v2.0: runs at 9:50 AM ET to generate market-context.json
// for Helios Fusion Bot. Replaces the old T&T watchlist.json.
//
// Output: scripts/market-context.json containing:
//   - Market-wide context (SPY/QQQ regime, ORB, gap, VWAP)
//   - Per-symbol context (ORB, gap fill %, rvol, ATR expansion, tier)
//   - Correlation matrix for pairs-divergence
//   - Warm-start learner state (carried from yesterday)
//   - Calendar risk context (Fed days, OPEX, holidays)
//
// Helios loads this once on startup and uses it as priors throughout the session.

import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  opportunityScore, computeATRExpansion, computeCorrelationMatrix,
  filterCandidate, rankCandidates, DEFAULT_FILTERS,
} from './lib/scanner.js';
import { classifyFromBars } from './lib/market-regime.js';
import { getCalendarContext } from './lib/calendar-context.js';
import { sendTelegram, telegramEnabled } from './telegram.js';
import { retry } from './lib/retry.js';
import { getTodayStr } from './lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────
const UNIVERSE = (process.env.HELIOS_UNIVERSE || process.env.UNIVERSE ||
  'PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK')
  .split(',').map(s => s.trim()).filter(Boolean);

const CONTEXT_PATH = process.env.MARKET_CONTEXT_PATH ||
  path.join(__dirname, 'market-context.json');
const LEARNER_STATE_PATH = path.join(__dirname, 'learner-state.json');
const SYMBOLS_STALE_MIN = 5; // mark context stale after N minutes

const HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// ─── Fetch daily bars + returns for universe + SPY/QQQ ──────────────

async function fetchDailyBars(symbols, periodDays = 25) {
  const end = getTodayStr();
  const start = new Date(Date.now() - periodDays * 86400000).toISOString().split('T')[0];
  const results = {};

  const BATCH = 4;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH).join(',');
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${batch}&timeframe=1Day&start=${start}&end=${end}&limit=${periodDays}&feed=iex`;
    const resp = await retry(() => fetch(url, { headers: HEADERS }));
    const data = await resp.json();

    for (const sym of symbols.slice(i, i + BATCH)) {
      const rawBars = data.bars?.[sym] || [];
      if (rawBars.length < 15) {
        console.log(`  ${sym}: insufficient daily data (${rawBars.length} bars)`);
        continue;
      }

      const bars = rawBars.map(b => ({
        h: b.h, l: b.l, c: b.c, v: b.v,
      }));

      // 14-period ATR
      let atrSum = 0;
      for (let j = bars.length - 14; j < bars.length; j++) {
        const prev = bars[j - 1];
        const cur = bars[j];
        const tr = Math.max(cur.h - cur.l,
          Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
        atrSum += tr;
      }
      const dailyATR = atrSum / 14;

      const lastClose = bars[bars.length - 1].c;
      const prevClose = bars.length > 1 ? bars[bars.length - 2].c : lastClose;
      const avgVol = bars.slice(-20).reduce((s, b) => s + b.v, 0) / Math.min(20, bars.length);

      // Daily returns for correlation (percent change from prev close)
      const returns = [];
      for (let j = 1; j < bars.length; j++) {
        returns.push((bars[j].c - bars[j - 1].c) / bars[j - 1].c * 100);
      }

      results[sym] = { dailyATR, lastClose, prevClose, avgVol, returns, bars };
      console.log(`  ${sym}: ATR=$${dailyATR.toFixed(2)} | Last=$${lastClose.toFixed(2)} | Vol=${(avgVol / 1e6).toFixed(1)}M`);
    }

    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// ─── Fetch intraday bars (ORB: 9:30–9:50 ET) ──────────────────────

async function fetchIntradayORB(symbols) {
  const today = getTodayStr();
  const orbResults = {};

  // We fetch 9:25–10:00 to get pre-context + the full 20-min ORB
  for (let i = 0; i < symbols.length; i += 4) {
    const batch = symbols.slice(i, i + 4).join(',');
    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${batch}&timeframe=5Min&start=${today}T09:25:00-04:00&end=${today}T10:00:00-04:00&limit=10&feed=iex`;

    const results = await Promise.allSettled(
      symbols.slice(i, i + 4).map(async (sym) => {
        const sUrl = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=5Min&start=${today}T09:25:00-04:00&end=${today}T10:00:00-04:00&limit=10&feed=iex`;
        const resp = await retry(() => fetch(sUrl, { headers: HEADERS }));
        const data = await resp.json();
        const rawBars = data.bars?.[sym] || [];
        return { sym, bars: rawBars.map(b => ({
          open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0, ts: b.t,
        })) };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.bars.length >= 3) {
        orbResults[r.value.sym] = r.value.bars;
      }
    }

    if (i + 4 < symbols.length) await new Promise(r => setTimeout(r, 200));
  }
  return orbResults;
}

// ─── Compute per-symbol context ──────────────────────────────────────

function buildSymbolContext(sym, dailyData, orbBars) {
  if (!dailyData || !orbBars || orbBars.length < 3) return null;

  // ORB from 9:30 bars (first 3-4 bars after open)
  const orbSlice = orbBars.slice(0, 4); // 4 bars = 20-min ORB
  const orbHigh = Math.max(...orbSlice.map(b => b.high));
  const orbLow = Math.min(...orbSlice.map(b => b.low));
  const orbRange = orbHigh - orbLow;
  const orbOpen = orbSlice[0].open;
  const orbClose = orbSlice[orbSlice.length - 1].close;
  const orbVolume = orbSlice.reduce((s, b) => s + b.volume, 0);

  // Gap from prev close
  const gapAbs = Math.abs(orbOpen - dailyData.prevClose);
  const gapPct = dailyData.prevClose > 0 ? (orbOpen - dailyData.prevClose) / dailyData.prevClose * 100 : 0;
  const absGapPct = Math.abs(gapPct);

  // rvol vs daily average (normalized to ~20-min window)
  const expectedVol = dailyData.avgVol > 0 ? (dailyData.avgVol / 78) * 4 : 0;
  const rvol = expectedVol > 0 ? orbVolume / expectedVol : 0;

  // Range/ATR ratio
  const rangeATRRatio = dailyData.dailyATR > 0 ? orbRange / dailyData.dailyATR : 0;

  // ATR% 
  const atrPct = dailyData.dailyATR / dailyData.lastClose * 100;

  // VWAP from ORB bars
  let cumTPV = 0, cumVol = 0;
  for (const b of orbSlice) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * (b.volume || 0);
    cumVol += (b.volume || 0);
  }
  const vwapAnchor = cumVol > 0 ? cumTPV / cumVol : dailyData.lastClose;

  // ATR expansion
  const atrExpansion = computeATRExpansion(orbRange, dailyData.dailyATR);

  // Gap fill progress (at end of ORB, how much of the gap is filled?)
  const gapFillPct = absGapPct > 0 && dailyData.prevClose > 0
    ? ((orbClose - orbOpen) / (dailyData.prevClose - orbOpen)) * 100
    : 0;

  // ─── Real Floor Trader Pivots ──────────────────────
  // Uses prior-day H/L/C from daily bars for proper S1/R1/S2/R2/PP
  let pivots = null;
  const dayBars = dailyData.bars;
  if (dayBars && dayBars.length >= 2) {
    const prior = dayBars[dayBars.length - 2]; // yesterday
    const priorH = prior.h;
    const priorL = prior.l;
    const priorC = prior.c;
    const PP = (priorH + priorL + priorC) / 3;
    pivots = {
      P: parseFloat(PP.toFixed(2)),
      S1: parseFloat((2 * PP - priorH).toFixed(2)),
      R1: parseFloat((2 * PP - priorL).toFixed(2)),
      S2: parseFloat((PP - (priorH - priorL)).toFixed(2)),
      R2: parseFloat((PP + (priorH - priorL)).toFixed(2)),
    };
  }

  // Opportunity score + tier
  const opp = opportunityScore({
    rangeHigh: orbHigh, rangeLow: orbLow, rangeOpen: orbOpen, rangeClose: orbClose,
    dailyATR: dailyData.dailyATR, price: dailyData.lastClose,
    prevClose: dailyData.prevClose, rvol, atrPct, gapPct: absGapPct, rangeATRRatio,
  });

  return {
    ob: {
      high: parseFloat(orbHigh.toFixed(2)),
      low: parseFloat(orbLow.toFixed(2)),
      open: parseFloat(orbOpen.toFixed(2)),
      close: parseFloat(orbClose.toFixed(2)),
      range: parseFloat(orbRange.toFixed(2)),
      rangeATRPct: parseFloat((rangeATRRatio * 100).toFixed(1)),
      direction: orbClose > orbOpen ? 'green' : 'red',
    },
    gap: {
      fromPrevClose: parseFloat(gapPct.toFixed(2)),
      abs: parseFloat(absGapPct.toFixed(2)),
      fillPct: parseFloat(gapFillPct.toFixed(1)),
      label: gapPct > 0 ? 'up' : 'down',
    },
    volume: {
      rvol: parseFloat(rvol.toFixed(2)),
      orbVolume: orbVolume,
      avgDaily: Math.round(dailyData.avgVol),
    },
    vwap: {
      anchor: parseFloat(vwapAnchor.toFixed(2)),
    },
    volatility: {
      dailyATR: parseFloat(dailyData.dailyATR.toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(1)),
      rangeATR: parseFloat(rangeATRRatio.toFixed(3)),
      atrExpansion,
    },
    pivots,
    opportunity: opp,
  };
}

// ─── Load yesterday's learner state ──────────────────────────────────

function loadLearnerState() {
  try {
    if (fs.existsSync(LEARNER_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(LEARNER_STATE_PATH, 'utf8'));
      // Only use if from yesterday (stale > 7 days = useless)
      const age = (Date.now() - new Date(data.savedAt).getTime()) / 86400000;
      if (age <= 7) {
        console.log(`Loaded learner state from ${data.savedAt} (${age.toFixed(1)} days old)`);
        return data;
      }
      console.log(`Learner state too old (${age.toFixed(0)} days), starting fresh`);
    }
  } catch (e) {
    console.log(`No learner state found (${e.message.split('\n')[0]})`);
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const today = getTodayStr();
  console.log(`☀️ Pre-market scan v2.0 — ${today} ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET`);
  console.log(`Universe: ${UNIVERSE.length} stocks → ${UNIVERSE.join(', ')}`);

  // ── Phase 1: Fetch daily data for universe + SPY/QQQ ────────────
  console.log(`\n📊 Phase 1: Fetching daily bars for universe + SPY/QQQ...`);
  const allDailySymbols = [...UNIVERSE, 'SPY', 'QQQ'];
  const dailyData = await fetchDailyBars(allDailySymbols);

  // ── Phase 2: Fetch intraday ORB for universe + SPY/QQQ ──────────
  console.log(`\n📈 Phase 2: Fetching intraday ORB bars...`);
  const orbBars = await fetchIntradayORB(allDailySymbols);

  // ── Phase 3: Market context (SPY/QQQ) ──────────────────────────
  console.log(`\n🌍 Phase 3: Computing market context...`);
  const market = {};

  for (const etf of ['SPY', 'QQQ']) {
    const bars = orbBars[etf] || [];
    const dd = dailyData[etf];

    if (bars.length >= 3) {
      const regime = classifyFromBars(bars);

      // Also compute ORB structure
      const orbSlice = bars.slice(0, 4);
      const orbHigh = Math.max(...orbSlice.map(b => b.high));
      const orbLow = Math.min(...orbSlice.map(b => b.low));
      const orbOpen = orbSlice[0].open;
      const orbClose = orbSlice[orbSlice.length - 1].close;

      market[etf.toLowerCase()] = {
        ob: {
          high: parseFloat(orbHigh.toFixed(2)),
          low: parseFloat(orbLow.toFixed(2)),
          open: parseFloat(orbOpen.toFixed(2)),
          close: parseFloat(orbClose.toFixed(2)),
          range: parseFloat((orbHigh - orbLow).toFixed(2)),
          direction: orbClose > orbOpen ? 'green' : 'red',
        },
        regime: regime.regime,
        spyDirection: regime.spyDirection,
        vwap: regime.metrics.vwap,
      };
    } else {
      market[etf.toLowerCase()] = { error: `only ${bars.length} bars available` };
    }
  }

  // ── Phase 4: Per-symbol context ─────────────────────────────────
  console.log(`\n🔍 Phase 4: Building per-symbol context...`);
  const symbols = {};
  const tierCounts = { full: 0, light: 0, skip: 0 };

  for (const sym of UNIVERSE) {
    const dd = dailyData[sym];
    const bars = orbBars[sym];
    const ctx = buildSymbolContext(sym, dd, bars);

    if (ctx) {
      symbols[sym] = ctx;
      tierCounts[ctx.opportunity.tier]++;
      console.log(`  ${sym}: tier=${ctx.opportunity.tier.toUpperCase()} score=${ctx.opportunity.score} | ORB ${ctx.ob.direction} | gap ${ctx.gap.abs}% | rvol ${ctx.volume.rvol.toFixed(1)}x | ATR ${ctx.volatility.atrExpansion.regime}`);
    } else {
      console.log(`  ${sym}: insufficient data — skipped`);
    }
  }

  // ── Phase 5: Correlation matrix ──────────────────────────────────
  console.log(`\n🔗 Phase 5: Computing correlation matrix...`);
  const returns = {};
  for (const sym of UNIVERSE) {
    if (dailyData[sym]?.returns) {
      returns[sym] = dailyData[sym].returns;
    }
  }
  const correlationMatrix = computeCorrelationMatrix(returns);

  // ── Phase 6: Calendar context ─────────────────────────────────────
  console.log(`\n📅 Phase 6: Calendar risk check...`);
  const calendar = getCalendarContext();
  console.log(`  Risk: ${calendar.risk} — ${calendar.reason}`);
  console.log(`  Flags: [${calendar.flags.join(', ') || 'none'}]`);

  // ── Phase 7: Learner state carry-forward ──────────────────────────
  console.log(`\n🧠 Phase 7: Learner state...`);
  const learnerState = loadLearnerState();

  // ── Phase 8: Assemble market-context.json ─────────────────────────
  console.log(`\n📦 Phase 8: Assembling market-context.json...`);
  const context = {
    date: getTodayStr(),
    generatedAt: new Date().toISOString(),
    generatedAtET: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    staleAfterMinutes: SYMBOLS_STALE_MIN,
    market,
    symbols,
    tiers: {
      full: UNIVERSE.filter(s => symbols[s]?.opportunity?.tier === 'full'),
      light: UNIVERSE.filter(s => symbols[s]?.opportunity?.tier === 'light'),
      skip: UNIVERSE.filter(s => !symbols[s] || symbols[s]?.opportunity?.tier === 'skip'),
    },
    correlationMatrix,
    learnerState,
    calendar,
    meta: {
      version: '2.0.0',
      universeCount: UNIVERSE.length,
      symbolCount: Object.keys(symbols).length,
    },
  };

  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(context, null, 2));
  console.log(`\n✅ Wrote market-context.json → ${CONTEXT_PATH}`);
  console.log(`   Full scan: ${tierCounts.full} | Light: ${tierCounts.light} | Skip: ${tierCounts.skip}`);

  // ── Telegram summary ───────────────────────────────────────────
  if (telegramEnabled()) {
    const fullList = context.tiers.full.join(', ') || 'none';
    const lightList = context.tiers.light.join(', ') || 'none';
    const spyDir = context.market?.spy?.ob?.direction || '?';
    const spyRegime = context.market?.spy?.regime || '?';

    let msg = `☀️ <b>PRE-MARKET SCAN</b> ${today}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 SPY: ${spyRegime} (${spyDir}) | QQQ: ${context.market?.qqq?.ob?.direction || '?'}\n`;
    msg += `📅 ${calendar.risk.toUpperCase()} — ${calendar.reason}\n`;
    msg += `\n🟢 <b>Full scan (${tierCounts.full}):</b> ${fullList}\n`;
    msg += `🟡 <b>Light scan (${tierCounts.light}):</b> ${lightList}\n`;

    if (tierCounts.full > 0) {
      msg += `\n<b>Top Opportunities:</b>\n`;
      const ranked = Object.entries(symbols)
        .filter(([,c]) => c.opportunity.tier === 'full')
        .sort(([,a], [,b]) => b.opportunity.score - a.opportunity.score);
      for (const [sym, ctx] of ranked.slice(0, 5)) {
        msg += `• ${sym}: score ${ctx.opportunity.score} | ORB ${ctx.ob.direction} | vol ${ctx.volatility.atrExpansion.regime}\n`;
      }
    }

    await sendTelegram(msg, { parseMode: 'HTML' }).catch(() => {});
  }
}

main().catch(e => { console.error(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
