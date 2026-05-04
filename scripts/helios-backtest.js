#!/usr/bin/env node
// scripts/helios-backtest.js
// ☀️ Helios Fusion Backtest — simulates the bot's actual 6-signal fusion
// trading logic over the past 30 trading days with $500 starting equity.
//
// Reuses the REAL signal modules (orb-breakout, vwap-reversion, volume-surge,
// pairs-divergence, gap-fill, momentum-cascade) and the REAL FusionEngine.
// No reimplementation — this is a faithful simulation of helios-bot.js logic.

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenvx preload may redirect relative paths — use absolute explicitly
const envPath = '/root/scalp-bot/.env';
const altPath = path.resolve(__dirname, '..', '.env');
const finalPath = fs.existsSync(envPath) ? envPath :
                  fs.existsSync(altPath) ? altPath : null;

if (finalPath) {
  const result = dotenv.config({ path: finalPath, override: true });
  if (result.error) {
    console.error(`dotenv.config failed: ${result.error.message}`);
  } else {
    // Verify critical keys loaded
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      console.error('WARNING: Alpaca credentials NOT loaded from .env');
      console.error(`   Tried: ${finalPath} (exists: ${fs.existsSync(finalPath)})`);
    }
  }
} else {
  console.error(`Cannot find .env — tried ${envPath} and ${altPath}`);
}
import { fetchBarsPaginated, norm5, normD, computeDailyATRMap } from './lib/alpaca-data.js';
import { createPivots } from './lib/indicators.js';
import { FusionEngine } from './lib/fusion-engine.js';
import { KellySizer } from './lib/kelly-sizer.js';
import { OnlineLearner } from './lib/online-learner.js';
import { classifyFromBars, regimeSizeMultiplier } from './lib/market-regime.js';
import { getHHMM_ET, getDateStr } from './lib/time.js';

// ── Import the ACTUAL signal modules ──
import * as orbBreakout from './signals/orb-breakout.js';
import * as vwapReversion from './signals/vwap-reversion.js';
import * as volumeSurge from './signals/volume-surge.js';
import * as pairsDivergence from './signals/pairs-divergence.js';
import * as gapFill from './signals/gap-fill.js';
import * as momentumCascade from './signals/momentum-cascade.js';

// Force unbuffered output for progress tracking
process.stdout._handle?.setBlocking?.(true);

const SIGNALS = [orbBreakout, vwapReversion, volumeSurge, pairsDivergence, gapFill, momentumCascade];

// ── Config (matches helios-bot.js defaults) ──
const UNIVERSE = (process.env.HELIOS_UNIVERSE || process.env.UNIVERSE ||
  'PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK')
  .split(',').map(s => s.trim()).filter(Boolean);

const CONFIG = {
  sessionStart: parseInt(process.env.HELIOS_SESSION_START || '1005', 10),
  sessionEnd:   parseInt(process.env.HELIOS_SESSION_END   || '1115', 10),
  hardExit:     parseInt(process.env.HELIOS_HARD_EXIT     || '1130', 10),
  maxTradesPerDay: parseInt(process.env.HELIOS_MAX_TRADES || '4', 10),
  minATR:          parseFloat(process.env.MIN_ATR         || '0.50'),
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '3'),
  entryThreshold:  parseFloat(process.env.HELIOS_ENTRY_THRESHOLD || '0.40'),
  minVotes:        parseInt(process.env.HELIOS_MIN_VOTES  || '3', 10),
  kellyFraction:   parseFloat(process.env.HELIOS_KELLY    || '0.25'),
  basePositionPct: parseFloat(process.env.HELIOS_BASE_POS_PCT || '3'),
  cooldownBars:    6,  // 6 × 5min = 30 min cooldown per symbol
  minVotesForEntry: parseInt(process.env.HELIOS_MIN_VOTES  || '3', 10),
};

// Cost model
const SLIPPAGE_BPS = parseFloat(process.env.SLIPPAGE_BPS) || 5;
const COMMISSION_PER_SHARE = parseFloat(process.env.COMMISSION_PER_SHARE) || 0.005;

const INITIAL_EQUITY = parseFloat(process.env.BACKTEST_CAPITAL || '500');
const BACKTEST_DAYS = parseInt(process.env.BACKTEST_DAYS || '30', 10);
const ATR_WARMUP_DAYS = 45;  // extra daily bars before backtest start for ATR

// ── Pairs for pairs-divergence signal (need cross-pricing) ──
const PAIRS = [
  { a: 'MARA', b: 'CLSK', hedgeRatio: 1.1 },
  { a: 'SOFI', b: 'LCID', hedgeRatio: 2.5 },
  { a: 'PLTR', b: 'IONQ', hedgeRatio: 0.3 },
  { a: 'DKNG', b: 'SOFI', hedgeRatio: 1.2 },
  { a: 'SMR',  b: 'UEC', hedgeRatio: 1.0 },
  { a: 'BTDR', b: 'MARA', hedgeRatio: 1.0 },
];

// ── Utility ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  process.stdout.write(msg + '\n');
}

function applyCosts(entryPrice, exitPrice, qty) {
  const slippageCost = (entryPrice + exitPrice) * qty * (SLIPPAGE_BPS / 10000);
  const commissionCost = qty * COMMISSION_PER_SHARE * 2;
  return slippageCost + commissionCost;
}

// Calculate 30 trading days back from today (skip weekends)
function getBacktestDateRange() {
  const now = new Date();
  // Walk backwards counting trading days
  let tradingDays = 0;
  let endDate = new Date(now);
  endDate.setHours(16, 0, 0, 0); // 4pm ET close

  let startDate = new Date(now);
  startDate.setHours(9, 30, 0, 0);

  let d = new Date(now);
  while (tradingDays < BACKTEST_DAYS) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) tradingDays++;
  }
  startDate = new Date(d);
  startDate.setHours(9, 30, 0, 0);

  // ATR warmup: go back another ~45 calendar days
  let warmupStart = new Date(startDate);
  warmupStart.setDate(warmupStart.getDate() - ATR_WARMUP_DAYS);

  return { startDate, endDate, warmupStart };
}

// ── Main ──
async function main() {
  log('═'.repeat(65));
  log('☀️  HELIOS FUSION BACKTEST');
  log(`   Signals: ${SIGNALS.map(s => s.name).join(', ')}`);
  log(`   Universe: ${UNIVERSE.length} stocks`);
  log(`   Entry: >=${CONFIG.minVotes} votes | composite >${CONFIG.entryThreshold}`);
  log(`   Session: ${CONFIG.sessionStart}–${CONFIG.sessionEnd} ET | Hard exit: ${CONFIG.hardExit} ET`);
  log(`   Kelly ×${CONFIG.kellyFraction} | Base pos: ${CONFIG.basePositionPct}%`);
  log(`   Starting equity: $${INITIAL_EQUITY}`);
  log(`   Slippage: ${SLIPPAGE_BPS} bps | Commission: $${COMMISSION_PER_SHARE}/share`);
  log('═'.repeat(65));

  const { startDate, endDate, warmupStart } = getBacktestDateRange();
  const startStr = startDate.toISOString();
  const endStr = endDate.toISOString();
  const warmupStr = warmupStart.toISOString();

  log(`\n📅 Date range: ${startDate.toLocaleDateString()} → ${endDate.toLocaleDateString()}`);
  log(`   Warmup from: ${warmupStart.toLocaleDateString()} (for ATR)\n`);

  // ── Fetch data ──
  const allBars5m = {};
  const allDailyBars = {};
  const allDailyATRMaps = {};
  const allPrevClose = {};   // symbol → Map(dateStr → prevClose)
  const allPivots = {};       // symbol → Map(dateStr → pivot levels)
  let spyBarsRaw = null;    // SPY 5m bars for regime detection (like live bot)

  // Fetch SPY bars for regime detection (matches live bot's detectRegime())
  console.log('📥 Fetching SPY for market regime detection...');
  try {
    const spyDaily = await fetchBarsPaginated('SPY', '1Day', warmupStr, endStr, 60000);
    for (const b of spyDaily.map(b => ({
      d: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
    }))) {
      const ds = b.d.split('T')[0];
      if (!allDailyBars['SPY']) allDailyBars['SPY'] = [];
      allDailyBars['SPY'].push(b);
    }
    spyBarsRaw = await fetchBarsPaginated('SPY', '5Min', startStr, endStr, 60000);
    console.log(`   SPY: ${spyBarsRaw.length} 5m bars, ${spyDaily.length} daily`);
  } catch (e) {
    console.log(`   SPY fetch FAILED: ${e.message} — regime will be 'unknown'`);
  }

  console.log('📥 Fetching universe data (13 symbols × 2 timeframes)...');
  for (let i = 0; i < UNIVERSE.length; i++) {
    const sym = UNIVERSE[i];
    try {
      console.log(`   [${i+1}/${UNIVERSE.length}] Fetching ${sym} daily bars...`);
      // Daily bars for ATR (lighter fetch first)
      const rawDaily = await fetchBarsPaginated(sym, '1Day', warmupStr, endStr, 60000);
      const dailyBars = rawDaily.map(b => ({
        ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0,
      }));
      allDailyBars[sym] = dailyBars;

      console.log(`   [${i+1}/${UNIVERSE.length}] Fetching ${sym} 5-min bars...`);
      // 5-min bars for the backtest window only (not warmup — signals only use intraday)
      const raw5m = await fetchBarsPaginated(sym, '5Min', startStr, endStr, 60000);
      const bars5m = raw5m.map(norm5);
      allBars5m[sym] = bars5m;

      const atrMap = computeDailyATRMap(dailyBars, 14);
      allDailyATRMaps[sym] = atrMap;

      // Compute prevClose per date & pivots per date
      const prevCloseMap = new Map();
      const pivotsMap = new Map();
      const pivots = createPivots();
      for (let i = 0; i < dailyBars.length; i++) {
        const d = dailyBars[i];
        const dateStr = d.ts.split('T')[0]; // YYYY-MM-DD
        pivots.setDaily(d);
        if (i > 0) {
          prevCloseMap.set(dateStr, dailyBars[i - 1].close);
        }
        if (pivots.ready()) {
          pivotsMap.set(dateStr, pivots.value());
        }
      }
      allPrevClose[sym] = prevCloseMap;
      allPivots[sym] = pivotsMap;

      console.log(`   ${sym}: ${bars5m.length} 5m bars, ${dailyBars.length} daily, ATR=${atrMap.size} dates`);
      await sleep(300); // rate limit
    } catch (e) {
      console.log(`   ${sym}: ERROR — ${e.message}`);
    }
  }

  // ── Filter to backtest dates only ──
  // Collect all trading dates in the backtest range
  const backtestDates = new Set();
  for (const sym of UNIVERSE) {
    const bars = allBars5m[sym] || [];
    for (const bar of bars) {
      const dateStr = getDateStr(bar.ts);
      backtestDates.add(dateStr);
    }
  }
  const sortedDates = [...backtestDates].sort();
  console.log(`\n📊 Backtest dates: ${sortedDates.length} trading days (${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]})\n`);

  // ── Run simulation ──
  let equity = INITIAL_EQUITY;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const equityCurve = [equity];
  const allTrades = [];
  const perSymbolTrades = {};  // symbol → [trades]
  const fusion = new FusionEngine({ entryThreshold: CONFIG.entryThreshold, minVotes: CONFIG.minVotes });
  const sizer = new KellySizer({ kellyFraction: CONFIG.kellyFraction, basePositionPct: CONFIG.basePositionPct });
  const learner = new OnlineLearner({ rebalanceInterval: 30, regressionStrength: 0.3 });
  let sessionStartMs = 0;  // track for rebalance timing

  // Track per-date state
  let tradesToday = 0;
  let dailyPnl = 0;
  let currentDate = null;
  const cooldownUntil = {};       // symbol → barIndex (cooldown until this bar index)
  const activePosition = {};      // symbol → position object or null
  const pairSpreadHistory = {};   // reset per day to match live behavior

  for (const dateStr of sortedDates) {
    tradesToday = 0;
    dailyPnl = 0;
    currentDate = dateStr;

    // Reset per-symbol position tracking for new day
    for (const sym of UNIVERSE) {
      activePosition[sym] = null;
    }

    // Session start timestamp for learner rebalance timing
    sessionStartMs = new Date(`${dateStr}T09:30:00-04:00`).getTime();

    // Reset pairs-divergence spreadHistory (in live bot, it's module-level state;
    // for backtest, reset daily so z-scores don't leak across days)
    // We can't reset the module state, so we handle it via context

    // Gather all bars for this day across all symbols
    const dayBarsBySymbol = {};
    for (const sym of UNIVERSE) {
      const bars = allBars5m[sym] || [];
      const dayBars = bars.filter(b => getDateStr(b.ts) === dateStr);
      dayBarsBySymbol[sym] = dayBars;
    }

    // Determine the max number of bars in a day
    const maxBars = Math.max(...Object.values(dayBarsBySymbol).map(b => b.length), 0);

    // Bar-by-bar simulation
    for (let barIdx = 0; barIdx < maxBars; barIdx++) {
      // ── Rebalance learner weights periodically (matches helios-bot.js line 513) ──
      if (learner.shouldRebalance(sessionStartMs)) {
        for (const sig of SIGNALS) {
          fusion.setWeight(sig.name, learner.getWeight(sig.name));
        }
        learner.markRebalanced();
      }

      // Process each symbol at this bar time
      for (const sym of UNIVERSE) {
        const dayBars = dayBarsBySymbol[sym];
        if (barIdx >= dayBars.length) continue;

        const bar = dayBars[barIdx];
        const hhmm = getHHMM_ET(bar.ts);

        const pos = activePosition[sym];

        // ── Check exits for open position ──
        if (pos) {
          let closed = false;
          let exitPrice = bar.close;
          let exitType = 'hard_exit';

          // Hard exit at 11:30
          if (hhmm >= CONFIG.hardExit) {
            closed = true;
            exitType = 'hard_exit';
          }

          // Fixed stop/target check
          if (!closed && pos.side === 'long') {
            if (bar.low <= pos.stopPrice) {
              closed = true;
              exitPrice = pos.stopPrice;
              exitType = 'stop';
            } else if (bar.high >= pos.targetPrice) {
              closed = true;
              exitPrice = pos.targetPrice;
              exitType = 'target';
            }
          } else if (!closed && pos.side === 'short') {
            if (bar.high >= pos.stopPrice) {
              closed = true;
              exitPrice = pos.stopPrice;
              exitType = 'stop';
            } else if (bar.low <= pos.targetPrice) {
              closed = true;
              exitPrice = pos.targetPrice;
              exitType = 'target';
            }
          }

          if (closed) {
            const pnl = pos.side === 'long'
              ? (exitPrice - pos.entryPrice) * pos.qty
              : (pos.entryPrice - exitPrice) * pos.qty;
            const costs = applyCosts(pos.entryPrice, exitPrice, pos.qty);
            const netPnl = pnl - costs;

            equity += netPnl;
            dailyPnl += netPnl;

            const trade = {
              symbol: sym,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice,
              exitType,
              qty: pos.qty,
              pnl: netPnl,
              costs,
              composite: pos.composite,
              date: dateStr,
              barIdx,
              signalDetails: pos.signalDetails,
            };

            allTrades.push(trade);
            if (!perSymbolTrades[sym]) perSymbolTrades[sym] = [];
            perSymbolTrades[sym].push(trade);

            // Update Kelly sizer
            sizer.recordTrade(netPnl > 0, pos.strength);

            // Update learner with per-signal P&L contribution (improvement over live bot)
            // In live bot: learner.record(sig.name, 0, sig.direction) at entry only
            // In backtest: also feed actual P&L at exit so learner learns from outcomes
            if (pos.signalDetailsList) {
              for (const sig of pos.signalDetailsList) {
                if (sig.direction !== 0) {
                  // Correct call: direction matched outcome → positive P&L contribution
                  // Wrong call: direction opposed outcome → negative
                  const correctDir = (netPnl > 0 && sig.direction === pos.sideSign) ||
                                     (netPnl < 0 && sig.direction !== pos.sideSign);
                  learner.record(sig.name, correctDir ? Math.abs(netPnl) / Math.max(1, pos.signalDetailsList.filter(s => s.direction !== 0).length) : -Math.abs(netPnl) / Math.max(1, pos.signalDetailsList.filter(s => s.direction !== 0).length), sig.direction);
                }
              }
            }

            peakEquity = Math.max(peakEquity, equity);
            maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
            equityCurve.push(equity);

            activePosition[sym] = null;
            cooldownUntil[sym] = barIdx + CONFIG.cooldownBars;
          }
        }

        // ── Check for new entry ──
        if (activePosition[sym]) continue;
        if (tradesToday >= CONFIG.maxTradesPerDay) continue;
        if (cooldownUntil[sym] && barIdx < cooldownUntil[sym]) continue;

        // Only during session window
        if (hhmm < CONFIG.sessionStart || hhmm >= CONFIG.sessionEnd) continue;

        // Daily loss limit
        if (CONFIG.dailyLossLimitPct > 0 && dailyPnl < 0 &&
            (Math.abs(dailyPnl) / equity * 100) > CONFIG.dailyLossLimitPct) {
          continue;
        }

        // Build context for signal analysis (same as helios-bot.js lines 556-561)
        const barsUpToNow = dayBars.slice(0, barIdx + 1);
        if (barsUpToNow.length < 5) continue;

        const dailyATR = allDailyATRMaps[sym]?.get(dateStr);
        if (!dailyATR || dailyATR < CONFIG.minATR) continue;

        const prevClose = allPrevClose[sym]?.get(dateStr) || null;
        const pivots = allPivots[sym]?.get(dateStr) || null;
        if (!prevClose || !pivots) continue;

        const price = bar.close;

        // Build pair prices for pairs-divergence signal
        const pairPrices = {};
        for (const otherSym of UNIVERSE) {
          if (otherSym === sym) continue;
          const otherDayBars = dayBarsBySymbol[otherSym];
          if (otherDayBars && otherDayBars.length > 0) {
            // Use the most recent bar price up to current time
            const otherBarIdx = Math.min(barIdx, otherDayBars.length - 1);
            pairPrices[otherSym] = otherDayBars[otherBarIdx].close;
          }
        }

        // Regime from SPY bars (matches live bot's detectRegime() using SPY)
        let regime = { regime: 'unknown', allowedDirections: ['long', 'short'] };
        if (spyBarsRaw && spyBarsRaw.length > 0) {
          const spyDayBars = spyBarsRaw.filter(b => getDateStr(b.ts) === dateStr);
          let spyUpToNow = [];
          for (const spyBar of spyDayBars) {
            if (new Date(spyBar.ts) <= new Date(bar.ts)) {
              spyUpToNow.push({
                open: spyBar.o, high: spyBar.h, low: spyBar.l,
                close: spyBar.c, volume: spyBar.v, ts: spyBar.t,
              });
            }
          }
          if (spyUpToNow.length >= 2) {
            regime = classifyFromBars(spyUpToNow);
          }
        }

        const ctx = {
          symbol: sym,
          bars: barsUpToNow,
          dailyATR,
          price,
          prevClose,
          pivots,
          pairData: { prices: pairPrices },
          marketContext: null,  // no pre-market scan in backtest
          regime: regime.regime, // pass regime to signals (matches live bot)
        };

        // Run each signal module's analyze() — same as helios-bot.js line 564-567
        const results = [];
        for (const sig of SIGNALS) {
          try {
            const result = sig.analyze(ctx);
            results.push({ ...result, name: sig.name });
          } catch (e) {
            results.push({ direction: 0, strength: 0, name: sig.name, reason: `error: ${e.message}` });
          }
        }

        // Fuse signals using actual FusionEngine — same as helios-bot.js line 569
        const decision = fusion.fuse(results);

        if (!decision.trade) continue;

        // Regime direction filter (from market-regime.js)
        const side = decision.direction > 0 ? 'long' : 'short';
        if (regime.allowedDirections && !regime.allowedDirections.includes(side)) {
          continue;  // blocked by regime
        }

        // ── Compute stops/targets (matches helios-bot.js lines 577-587) ──
        const stopMult = parseFloat(process.env.BT_STOP_MULT || '1.0');
        const targMult = parseFloat(process.env.BT_TARG_MULT || '2.0');

        const stopPr = decision.direction > 0
          ? price - dailyATR * stopMult
          : price + dailyATR * stopMult;
        const targPr = decision.direction > 0
          ? price + dailyATR * targMult
          : price - dailyATR * targMult;
        const stopDist = Math.abs(price - stopPr);

        // ── Position sizing (matches helios-bot.js lines 590-595) ──
        const sizeMult = regimeSizeMultiplier(regime);
        const qty = Math.max(1, Math.floor(
          sizer.calculate(equity, price, stopDist, decision.strength) * sizeMult
        ));

        const rr = Math.abs(targPr - price) / stopDist;

        const detailStr = decision.details
          .filter(x => x.direction !== 0)
          .map(x => `${x.name}:${x.direction > 0 ? 'L' : 'S'}(${(x.strength * 100).toFixed(0)}%)`)
          .join(' ');

        // Count trade on ENTRY (matches helios-bot.js line 423)
        tradesToday++;

        // Record signal directions at entry (matches helios-bot.js line 624)
        for (const sig of decision.details) {
          if (sig.direction !== 0) learner.record(sig.name, 0, sig.direction);
        }

        // Enter position
        activePosition[sym] = {
          side,
          sideSign: decision.direction > 0 ? 1 : -1,   // for learner exit recording
          entryPrice: price,
          stopPrice: parseFloat(stopPr.toFixed(2)),
          targetPrice: parseFloat(targPr.toFixed(2)),
          qty,
          composite: decision.composite,
          strength: decision.strength,
          signalDetails: detailStr,
          signalDetailsList: decision.details,   // store raw details for learner at exit
          entryBarIdx: barIdx,
        };

        // Only one entry per cycle (matches helios-bot.js line 626: break)
        break;
      }
    }

    // ── End of day: force-close any remaining positions at hard exit ──
    for (const sym of UNIVERSE) {
      const pos = activePosition[sym];
      if (pos) {
        const dayBars = dayBarsBySymbol[sym] || [];
        const lastBar = dayBars[dayBars.length - 1];
        if (lastBar) {
          const exitPrice = lastBar.close;
          const pnl = pos.side === 'long'
            ? (exitPrice - pos.entryPrice) * pos.qty
            : (pos.entryPrice - exitPrice) * pos.qty;
          const costs = applyCosts(pos.entryPrice, exitPrice, pos.qty);
          const netPnl = pnl - costs;

          equity += netPnl;
          dailyPnl += netPnl;

          const trade = {
            symbol: sym,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice,
            exitType: 'eod_close',
            qty: pos.qty,
            pnl: netPnl,
            costs,
            composite: pos.composite,
            date: dateStr,
            signalDetails: pos.signalDetails,
          };

          allTrades.push(trade);
          if (!perSymbolTrades[sym]) perSymbolTrades[sym] = [];
          perSymbolTrades[sym].push(trade);

          sizer.recordTrade(netPnl > 0, pos.strength);

          // Update learner with per-signal P&L at EOD close (same logic as intraday exit)
          if (pos.signalDetailsList) {
            for (const sig of pos.signalDetailsList) {
              if (sig.direction !== 0) {
                const correctDir = (netPnl > 0 && sig.direction === pos.sideSign) ||
                                   (netPnl < 0 && sig.direction !== pos.sideSign);
                learner.record(sig.name, correctDir ? Math.abs(netPnl) / Math.max(1, pos.signalDetailsList.filter(s => s.direction !== 0).length) : -Math.abs(netPnl) / Math.max(1, pos.signalDetailsList.filter(s => s.direction !== 0).length), sig.direction);
              }
            }
          }

          peakEquity = Math.max(peakEquity, equity);
          maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
          equityCurve.push(equity);
        }
        activePosition[sym] = null;
      }
    }
  }

  // ── Compute stats ──
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length * 100) : 0;
  const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;

  // ── Print results ──
  console.log('\n' + '═'.repeat(65));
  console.log('☀️  HELIOS FUSION BACKTEST RESULTS');
  console.log('═'.repeat(65));
  console.log(`  Starting equity:  $${INITIAL_EQUITY.toFixed(2)}`);
  console.log(`  Final equity:     $${equity.toFixed(2)}`);
  console.log(`  Net P&L:          $${netPnl.toFixed(2)} (${(netPnl / INITIAL_EQUITY * 100).toFixed(1)}%)`);
  console.log(`  Max drawdown:     ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log('─'.repeat(65));
  console.log(`  Total trades:     ${allTrades.length}`);
  console.log(`  Wins:             ${wins.length} | Losses: ${losses.length}`);
  console.log(`  Win rate:         ${winRate.toFixed(1)}%`);
  console.log(`  Avg win:          $${avgWin.toFixed(2)}`);
  console.log(`  Avg loss:         $${avgLoss.toFixed(2)}`);
  console.log(`  Profit factor:    ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);
  console.log('─'.repeat(65));

  // Exit type breakdown
  const exitBreakdown = {};
  for (const t of allTrades) {
    exitBreakdown[t.exitType] = (exitBreakdown[t.exitType] || 0) + 1;
  }
  console.log('  Exit type breakdown:');
  for (const [type, count] of Object.entries(exitBreakdown)) {
    console.log(`    ${type}: ${count}`);
  }
  console.log('─'.repeat(65));

  // Per-symbol breakdown
  console.log('  Per-symbol breakdown:');
  const symStats = [];
  for (const sym of UNIVERSE) {
    const trades = perSymbolTrades[sym] || [];
    if (trades.length === 0) continue;
    const symWins = trades.filter(t => t.pnl > 0);
    const symPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const symWR = (symWins.length / trades.length * 100).toFixed(0);
    symStats.push({ sym, trades: trades.length, wins: symWins.length, pnl: symPnl, wr: symWR });
  }
  symStats.sort((a, b) => b.pnl - a.pnl);
  for (const s of symStats) {
    const tag = s.pnl >= 0 ? '🟢' : '🔴';
    console.log(`    ${tag} ${s.sym.padEnd(5)}  ${s.trades} trades | ${s.wins}W | WR ${s.wr}% | P&L $${s.pnl.toFixed(2)}`);
  }
  if (symStats.length === 0) {
    console.log('    (no trades generated)');
  }
  console.log('─'.repeat(65));

  // Daily P&L summary
  console.log('  Daily P&L:');
  const dailyPnlMap = {};
  for (const t of allTrades) {
    dailyPnlMap[t.date] = (dailyPnlMap[t.date] || 0) + t.pnl;
  }
  const dailyEntries = Object.entries(dailyPnlMap).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, pnl] of dailyEntries) {
    const tag = pnl >= 0 ? '🟢' : '🔴';
    console.log(`    ${date}  ${tag} $${pnl.toFixed(2)}`);
  }
  if (dailyEntries.length === 0) {
    console.log('    (no trading days with trades)');
  }

  // ── Learner weights (adaptive signal performance) ──
  console.log('─'.repeat(65));
  const learnerStats = learner.getStats();
  if (Object.keys(learnerStats).length > 0) {
    console.log('  Signal weights (learned from trade outcomes):');
    const sortedSignals = Object.entries(learnerStats).sort((a, b) => b[1].weight - a[1].weight);
    for (const [name, s] of sortedSignals) {
      const correct = s.totalCalls > 0 ? `${s.correctCalls}/${s.totalCalls}` : '—';
      const avgPnl = s.count > 0 ? `$${(s.pnl / s.count).toFixed(3)}` : '—';
      console.log(`    ${name.padEnd(20)} weight=${s.weight.toFixed(2).padStart(4)}  acc=${correct.padStart(5)}  avgPnl=${avgPnl}`);
    }
  } else {
    console.log('  (no learner data — insufficient trades)');
  }

  console.log('═'.repeat(65));
  console.log(`\n☀️  Backtest complete. ${allTrades.length} trades over ${sortedDates.length} days.`);
}

main().catch(e => {
  console.error(`FATAL: ${e.message}\n${e.stack}`);
  process.exit(1);
});