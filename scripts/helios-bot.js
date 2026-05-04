#!/usr/bin/env node
// scripts/helios-bot.js
// ☀️ Helios — Multi-Signal Fusion Bot v2.0
// Aggregates 6 independent alpha signals via consensus voting with online
// adaptive weighting. Only enters when ≥2 signals agree or composite >0.25.
//
// v2.0: Consumes market-context.json from pre-market scan.
//   - Tiered scanning (full/light/skip)
//   - Warm-start learner from yesterday
//   - Calendar risk adjustments (FOMC, OPEX, holidays)
//   - Market context passed to all signal analyzers
//   - Learner state persisted for carry-forward
//   - ATR expansion-aware stop placement

import dotenv from 'dotenv';
dotenv.config();

import Alpaca from '@alpacahq/alpaca-trade-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram, tgError, tgShutdown, telegramEnabled } from './telegram.js';
import { retry, withTimeout } from './lib/retry.js';
import { getNYTime, getHHMM, getTodayStr } from './lib/time.js';
import { createPivots } from './lib/indicators.js';
import { detectRegime, regimeSizeMultiplier } from './lib/market-regime.js';
import { FusionEngine } from './lib/fusion-engine.js';
import { OnlineLearner } from './lib/online-learner.js';
import { KellySizer } from './lib/kelly-sizer.js';

import * as orbBreakout from './signals/orb-breakout.js';
import * as vwapReversion from './signals/vwap-reversion.js';
import * as volumeSurge from './signals/volume-surge.js';
import * as pairsDivergence from './signals/pairs-divergence.js';
import * as gapFill from './signals/gap-fill.js';
import * as momentumCascade from './signals/momentum-cascade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNIVERSE = (process.env.HELIOS_UNIVERSE || process.env.UNIVERSE ||
  'PLTR,LCID,SOFI,MARA,BTDR,DKNG,QS,SMR,UEC,IONQ,NCLH,SOUN,CLSK')
  .split(',').map(s => s.trim()).filter(Boolean);

const DRY_RUN = process.env.DRY_RUN === 'true';
const IS_PAPER = process.env.ALPACA_PAPER !== 'false';

// ─── Paths ─────────────────────────────────────────────────────────
const CONTEXT_PATH = process.env.MARKET_CONTEXT_PATH ||
  path.join(__dirname, 'market-context.json');
const LEARNER_STATE_PATH = path.join(__dirname, 'learner-state.json');

// ─── Config ────────────────────────────────────────────────────────
const CONFIG = {
  sessionStart: parseInt(process.env.HELIOS_SESSION_START || '1005', 10),
  sessionEnd:   parseInt(process.env.HELIOS_SESSION_END   || '1115', 10),
  hardExit:     parseInt(process.env.HELIOS_HARD_EXIT     || '1130', 10),
  pollIntervalMs:  parseInt(process.env.HELIOS_POLL_MS    || '60000', 10),
  apiTimeoutMs:    parseInt(process.env.API_TIMEOUT_MS    || '30000', 10),
  minATR:          parseFloat(process.env.MIN_ATR         || '0.50'),
  maxTradesPerDay: parseInt(process.env.HELIOS_MAX_TRADES || '4', 10),
  maxEquityPct:    parseFloat(process.env.MAX_EQUITY_PCT  || '40'),
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '3'),
  entryThreshold:  parseFloat(process.env.HELIOS_ENTRY_THRESHOLD || '0.40'),
  minVotes:        parseInt(process.env.HELIOS_MIN_VOTES  || '3', 10),
  kellyFraction:   parseFloat(process.env.HELIOS_KELLY     || '0.25'),
  basePositionPct: parseFloat(process.env.HELIOS_BASE_POS_PCT || '3'),
  unfilledTimeoutMin: parseInt(process.env.UNFILLED_TIMEOUT_MIN || '15', 10),
  cooldownMin:     parseInt(process.env.HELIOS_COOLDOWN_MIN || '30', 10),
  contextStaleMin: parseInt(process.env.HELIOS_CONTEXT_STALE_MIN || '5', 10),
};

const SIGNALS = [orbBreakout, vwapReversion, volumeSurge, pairsDivergence, gapFill, momentumCascade];
const fusion  = new FusionEngine({ entryThreshold: CONFIG.entryThreshold, minVotes: CONFIG.minVotes });
const sizer   = new KellySizer({ kellyFraction: CONFIG.kellyFraction, basePositionPct: CONFIG.basePositionPct });

let learner; // set after context load
let marketContext = null; // loaded from market-context.json
let currentRegime = null; // updated each cycle (line 488 detectRegime)
const lastSymbolScanMs = new Map(); // per-symbol last scan timestamp

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY, secretKey: process.env.ALPACA_SECRET_KEY,
  paper: IS_PAPER, feed: 'iex',
});

const activePositions = new Map();
let isShuttingDown = false;
let dailyPnl = 0, tradesToday = 0;
const cooldowns = new Map();
let sessionStartMs;
let pollCounter = 0; // for tiered scanning

const tradeLog = [];
function log(msg, level = 'info') {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const prefix = level === 'error' ? 'ERR' : level === 'trade' ? 'TRD' : 'INF';
  console.log(`[${ts} ET] [${prefix}] [☀️] ${msg}`);
  tradeLog.push({ ts, level, msg });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Cancel all open orders for a symbol ────────────────────────────
async function cancelPendingOrders(sym) {
  if (DRY_RUN) return;
  try {
    const orders = await retry(() => withTimeout(() => alpaca.getOrders({ status: 'open', symbols: [sym] }), CONFIG.apiTimeoutMs, 'getOrders'));
    for (const order of orders) {
      await retry(() => withTimeout(() => alpaca.cancelOrder(order.id), CONFIG.apiTimeoutMs, 'cancelOrder'));
      log(`${sym}: Cancelled open order ${order.id} (${order.side} ${order.type})`);
    }
  } catch (e) {
    log(`${sym}: Error cancelling orders: ${e.message}`, 'error');
  }
}

// ─── Load market context ────────────────────────────────────────────
function loadMarketContext() {
  try {
    if (fs.existsSync(CONTEXT_PATH)) {
      const raw = fs.readFileSync(CONTEXT_PATH, 'utf8');
      const ctx = JSON.parse(raw);

      // Check age — stale if older than contextStaleMin minutes
      const ageMs = Date.now() - new Date(ctx.generatedAt).getTime();
      const ageMin = ageMs / 60000;

      if (ageMin < CONFIG.contextStaleMin) {
        log(`Loaded market context (${ageMin.toFixed(1)}m old) — ${ctx.meta?.symbolCount || '?'} symbols`);
        log(`Tiers: full=${ctx.tiers?.full?.length || 0} light=${ctx.tiers?.light?.length || 0} skip=${ctx.tiers?.skip?.length || 0}`);
        log(`Calendar: ${ctx.calendar?.risk || 'unknown'} — ${ctx.calendar?.reason || '?'}`);
        return ctx;
      } else {
        log(`Market context too stale (${ageMin.toFixed(0)}m old > ${CONFIG.contextStaleMin}m limit)`, 'error');
        return null;
      }
    }
    log('No market-context.json found — running without pre-market context');
  } catch (e) {
    log(`Error loading context: ${e.message}`, 'error');
  }
  return null;
}

// ─── Apply calendar adjustments ─────────────────────────────────────
function applyCalendar(context) {
  if (!context?.calendar) return;

  const cal = context.calendar;

  // Adjust Kelly fraction
  const rawKelly = CONFIG.kellyFraction;
  const adjustedKelly = rawKelly * (cal.kellyMultiplier ?? 1.0);
  sizer.kellyFraction = adjustedKelly;
  log(`Kelly: ${rawKelly} → ${adjustedKelly.toFixed(3)} (×${(cal.kellyMultiplier ?? 1.0).toFixed(2)} — ${cal.risk})`);

  // Halve max trades on high risk days
  if (cal.risk === 'high') {
    CONFIG.maxTradesPerDay = Math.max(1, Math.floor(CONFIG.maxTradesPerDay / 2));
    log(`Max trades halved → ${CONFIG.maxTradesPerDay}`);
  }

  // Deprioritize signals by reducing initial weight
  if (cal.deprioritize?.length > 0 && context.learnerState) {
    log(`Deprioritizing: [${cal.deprioritize.join(', ')}]`);
    for (const sigName of cal.deprioritize) {
      fusion.setWeight(sigName, 0.5); // half weight for deprioritized signals
    }
  }

  // Holidays: block all entries
  if (cal.flags?.includes('HOLIDAY')) {
    log('Market holiday — blocking all entries');
    CONFIG.maxTradesPerDay = 0;
  }
}

// ─── Determine scan tier and throttle for a symbol ──────────────────
function getScanTier(sym) {
  if (!marketContext?.tiers) return 'full'; // no context = full scan
  if (marketContext.tiers.full?.includes(sym)) return 'full';
  if (marketContext.tiers.light?.includes(sym)) return 'light';
  return 'skip';
}

function shouldScanToday(sym) {
  const tier = getScanTier(sym);
  if (tier === 'skip') return false;
  if (tier === 'full') return true;

  // 'light' tier: scan every 3rd interval
  const lastScan = lastSymbolScanMs.get(sym) || 0;
  const intervalMs = CONFIG.pollIntervalMs * 3;
  return Date.now() - lastScan >= intervalMs;
}

// ─── Close a position at market ──────────────────────────────────────
async function closePosition(sym, reason = 'hard exit') {
  if (DRY_RUN) {
    log(`${sym}: Closing position (DRY RUN) — ${reason}`, 'trade');
    return true;
  }
  await cancelPendingOrders(sym);
  await sleep(500);

  try {
    const alpacaPos = await retry(() => withTimeout(() => alpaca.getPosition(sym), CONFIG.apiTimeoutMs, 'getPosition')).catch(() => null);
    if (alpacaPos && parseFloat(alpacaPos.qty) > 0) {
      const pos = activePositions.get(sym);
      if (pos) pos.pnl = parseFloat(alpacaPos.unrealized_pl);
      await retry(() => withTimeout(() => alpaca.closePosition(sym), CONFIG.apiTimeoutMs, 'closePosition'));
      const pnl = pos?.pnl ?? 0;
      dailyPnl += pnl;
      log(`${sym}: Position closed (${reason}) — P&L: $${pnl.toFixed(2)}`, 'trade');
      if (pos) recordLearnerExit(pos, pnl);
      return true;
    }
    return true;
  } catch (e) {
    log(`${sym}: Error closing position: ${e.message}`, 'error');
    await tgError(`${sym} close failed (${reason}): ${e.message}`);
    return false;
  }
}

// ─── Record learner P&L when a position exits ──────────────────────
// Feeds actual trade P&L per signal to the learner so it can
// upweight profitable signals and downweight losing ones.
// Uses signal strength as a weight — confident signals get more blame/credit.
function recordLearnerExit(pos, pnl) {
  if (!pos.signalDetailsList) return;
  const activeSigs = pos.signalDetailsList.filter(s => s.direction !== 0);
  const totalStrength = activeSigs.reduce((sum, s) => sum + (s.strength || 0.5), 0);
  for (const sig of pos.signalDetailsList) {
    if (sig.direction === 0) continue;
    const correctDir = (pnl > 0 && sig.direction === pos.sideSign) ||
                       (pnl < 0 && sig.direction !== pos.sideSign);
    const share = totalStrength > 0 ? (sig.strength || 0.5) / totalStrength : 1 / activeSigs.length;
    const contribution = correctDir
      ? Math.abs(pnl) * share
      : -Math.abs(pnl) * share;
    learner.record(sig.name, contribution, sig.direction);
  }
  // Update Kelly sizer win rate so position sizing adapts
  if (sizer && typeof sizer.recordTrade === 'function') {
    sizer.recordTrade(pnl > 0, pos.composite ?? 0.5);
  }
}

// ─── Close all tracked positions ─────────────────────────────────────
async function closeAllPositions() {
  const closeOps = [];
  for (const [sym, pos] of activePositions) {
    if (pos.status === 'closed') continue;

    if (pos.status === 'pending' && pos.orderId && pos.orderId !== 'dry-run' && !DRY_RUN) {
      closeOps.push((async () => {
        try {
          await cancelPendingOrders(sym);
          log(`${sym}: Cancelled pending order at hard exit`, 'trade');
          pos.status = 'closed';
        } catch (e) { log(`${sym}: Cancel failed: ${e.message}`, 'error'); }
      })());
      continue;
    }

    if (pos.status === 'filled') {
      closeOps.push(closePosition(sym, 'hard exit'));
      pos.status = 'closed';
      continue;
    }

    if (pos.status === 'dry_run') {
      log(`${sym}: DRY RUN — would close position at hard exit`, 'trade');
      pos.status = 'closed';
    }
  }
  await Promise.allSettled(closeOps);
}

// ─── Check for existing positions ────────────────────────────────────
async function getExistingPositionSymbols() {
  if (DRY_RUN) return new Set();
  try {
    const positions = await retry(() => withTimeout(() => alpaca.getPositions(), CONFIG.apiTimeoutMs, 'getPositions'));
    return new Set(positions.map(p => p.symbol));
  } catch (e) {
    log(`Could not fetch existing positions: ${e.message}`, 'error');
    return new Set();
  }
}

// ─── Data fetch (batch, only for eligible symbols) ───────────────────
async function fetchSymbolData(symbols = UNIVERSE) {
  const today = getTodayStr();
  const h = { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
  const data = {};

  for (let i = 0; i < symbols.length; i += 4) {
    const batch = symbols.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(async (sym) => {
      // Intraday bars
      const iUrl = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=5Min&start=${today}T09:30:00-04:00&end=${today}T16:30:00-04:00&limit=78&feed=iex`;
      const iResp = await retry(() => fetch(iUrl, { headers: h, signal: AbortSignal.timeout(CONFIG.apiTimeoutMs) }));
      const iJson = await iResp.json();
      const bars = (iJson.bars?.[sym] || []).map(b => ({
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0, ts: b.t,
      }));

      // Daily ATR + real floor trader pivots from context or compute fresh
      const symCtx = marketContext?.symbols?.[sym];
      let dailyATR, price, prevClose, pivots;

      if (symCtx) {
        dailyATR = symCtx.volatility?.dailyATR || null;
        price = symCtx.volatility?.dailyATR ? symCtx.ob?.close : bars[bars.length - 1]?.close;
        prevClose = symCtx.volatility?.dailyATR ? bars[0]?.open : null;
        pivots = symCtx.pivots || null; // ✓ real pivots from pre-market scan
      } else {
        dailyATR = null;
        price = bars.length > 0 ? bars[bars.length - 1].close : null;
        prevClose = bars.length > 0 ? bars[0].open : null;
        pivots = null;
      }

      return { sym, bars, dailyATR, price, prevClose, pivots };
    }));

    for (const r of results)
      if (r.status === 'fulfilled' && r.value) data[r.value.sym] = r.value;
    if (i + 4 < symbols.length) await sleep(500);
  }
  return data;
}

// ─── Place bracket order ─────────────────────────────────────────────
async function placeOrder(sym, side, entryPrice, stopPrice, targetPrice, qty) {
  const dir = side === 'long' ? 'buy' : 'sell';
  if (DRY_RUN) {
    log(`${sym} ${side.toUpperCase()} qty=${qty} @ $${entryPrice.toFixed(2)} [DRY]`, 'trade');
    return { id: `dry-${sym}`, status: 'dry_run' };
  }
  try {
    const order = await retry(() => withTimeout(() => alpaca.createOrder({
      symbol: sym, qty, side: dir, type: 'limit',
      limit_price: entryPrice.toFixed(2), time_in_force: 'day',
      order_class: 'bracket',
      stop_loss: { stop_price: stopPrice.toFixed(2) },
      take_profit: { limit_price: targetPrice.toFixed(2) },
    }), CONFIG.apiTimeoutMs, 'createOrder'));
    log(`${sym} ${side.toUpperCase()} order placed: qty=${qty} @ limit $${entryPrice.toFixed(2)} | SL=$${stopPrice.toFixed(2)} TP=$${targetPrice.toFixed(2)} | Order: ${order.id}`, 'trade');
    return order;
  } catch (e) {
    log(`${sym} ORDER FAILED: ${e.message}`, 'error');
    await tgError(`☀️ ${sym} order failed: ${e.message}`);
    return null;
  }
}

// ─── Monitor existing positions ──────────────────────────────────────
async function monitorPositions() {
  for (const [sym, pos] of activePositions) {
    if (pos.status === 'closed' || pos.status === 'dry_run') continue;

    // Unfilled timeout
    if (pos.status === 'pending' && pos.placedAt) {
      const elapsed = (Date.now() - pos.placedAt) / 60000;
      if (elapsed >= CONFIG.unfilledTimeoutMin) {
        if (DRY_RUN) {
          log(`${sym}: DRY RUN — would cancel unfilled order (timeout ${CONFIG.unfilledTimeoutMin} min)`, 'trade');
          pos.status = 'closed';
        } else {
          try {
            await cancelPendingOrders(sym);
            log(`${sym}: Cancelled unfilled order (timeout ${CONFIG.unfilledTimeoutMin} min)`, 'trade');
            pos.status = 'closed';
            cooldowns.set(sym, Date.now() + CONFIG.cooldownMin * 60000);
          } catch (e) { log(`${sym}: Unfilled cancel failed: ${e.message}`, 'error'); }
        }
        continue;
      }
    }

    // Poll order status
    if (pos.status === 'pending' && pos.orderId && !DRY_RUN) {
      try {
        const order = await retry(() => withTimeout(() => alpaca.getOrder(pos.orderId), CONFIG.apiTimeoutMs, 'getOrder'));
        if (order.status === 'filled') {
          pos.fillPrice = parseFloat(order.filled_avg_price ?? order.limit_price ?? pos.entryPrice);
          pos.filledAt = Date.now();
          pos.status = 'filled';
          const slippage = pos.fillPrice - pos.entryPrice;
          const slippageBps = pos.entryPrice > 0 ? Math.abs(slippage / pos.entryPrice * 10000) : 0;
          const tag = slippageBps > 0
            ? ` (slippage: $${slippage >= 0 ? '+' : ''}${slippage.toFixed(4)} / ${slippageBps.toFixed(1)} bps${slippage < 0 ? ' ⚠️ ADVERSE' : ''})`
            : '';
          log(`${sym}: FILLED at $${pos.fillPrice.toFixed(2)}${tag}`, 'trade');
        } else if (['canceled', 'rejected', 'expired'].includes(order.status)) {
          pos.status = 'closed';
          log(`${sym}: Order ${order.status}`, 'trade');
          cooldowns.set(sym, Date.now() + CONFIG.cooldownMin * 60000);
        }
      } catch {
        try {
          const alpacaPos = await retry(() => withTimeout(() => alpaca.getPosition(sym), CONFIG.apiTimeoutMs, 'getPosition'));
          if (alpacaPos && parseFloat(alpacaPos.qty) > 0) {
            pos.fillPrice = parseFloat(alpacaPos.avg_entry_price);
            pos.filledAt = Date.now();
            pos.status = 'filled';
          }
        } catch {}
      }
    }

    // Check if position closed by bracket (stop/target)
    if (pos.status === 'filled' && !DRY_RUN) {
      try {
        const alpacaPos = await retry(() => withTimeout(() => alpaca.getPosition(sym), CONFIG.apiTimeoutMs, 'getPosition')).catch(() => null);
        if (!alpacaPos || parseFloat(alpacaPos.qty) === 0) {
          pos.pnl = 0;
          try {
            const closedOrders = await retry(() => withTimeout(() => alpaca.getOrders({
              status: 'closed', symbols: [sym], limit: 5, direction: 'desc',
            }), CONFIG.apiTimeoutMs, 'getOrders'));
            const exitOrder = closedOrders.find(o =>
              o.side !== (pos.side === 'long' ? 'buy' : 'sell') &&
              o.filled_at && new Date(o.filled_at) > new Date(pos.filledAt)
            );
            if (exitOrder) {
              const fillQty = parseFloat(exitOrder.filled_qty);
              const fillPrice = parseFloat(exitOrder.filled_avg_price);
              const entryCost = pos.fillPrice * fillQty;
              const exitValue = fillPrice * fillQty;
              pos.pnl = pos.side === 'long' ? exitValue - entryCost : entryCost - exitValue;
            }
          } catch {}

          dailyPnl += pos.pnl;
          const exitTag = pos.pnl >= 0 ? 'TARGET' : 'STOP';
          log(`${sym}: Position closed (by ${exitTag}) — P&L: $${pos.pnl.toFixed(2)}`, 'trade');
          recordLearnerExit(pos, pos.pnl);
          cooldowns.set(sym, Date.now() + CONFIG.cooldownMin * 60000);
          pos.status = 'closed';
          tradesToday++;
        } else {
          pos.pnl = parseFloat(alpacaPos.unrealized_pl);
        }
      } catch {}
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  log('═'.repeat(60));
  log(`☀️ Helios Fusion Bot v2.0 — ${IS_PAPER ? 'PAPER' : 'LIVE'} — DRY=${DRY_RUN}`);
  log(`Signals: ${SIGNALS.map(s => s.name).join(', ')} | Universe: ${UNIVERSE.length} stocks`);
  log('═'.repeat(60));

  startPeriodicSave();

  // ── Phase 0: Load market context ─────────────────────────────────
  marketContext = loadMarketContext();

  // ── Phase 1: Initialize learner (warm-start or fresh) ────────────
  if (marketContext?.learnerState) {
    learner = OnlineLearner.fromJSON(marketContext.learnerState);
    log(`Learner: warm-started from ${marketContext.learnerState.savedAt || 'prior session'}`);
  } else {
    learner = new OnlineLearner();
    log('Learner: fresh start (no prior state)');
  }

  // ── Phase 2: Apply calendar risk adjustments ─────────────────────
  applyCalendar(marketContext);

  log(`Fusion: >=${CONFIG.minVotes} votes | composite >${CONFIG.entryThreshold} | max ${CONFIG.maxTradesPerDay} trades`);
  log(`Window: ${CONFIG.sessionStart}–${CONFIG.sessionEnd} ET | Hard exit: ${CONFIG.hardExit} ET`);
  log(`Kelly ×${sizer.kellyFraction.toFixed(3)} | Base pos: ${CONFIG.basePositionPct}% | Max equity: ${CONFIG.maxEquityPct}%`);
  log('═'.repeat(60));

  sessionStartMs = Date.now();

  const account = await retry(() => withTimeout(() => alpaca.getAccount(), CONFIG.apiTimeoutMs, 'getAccount'));
  const equity = parseFloat(account.portfolio_value);
  log(`Equity: $${equity.toFixed(2)}`);

  const regime = await detectRegime().catch(() => null);
  currentRegime = regime; // store for signal access
  log(`Regime: ${regime?.regime || 'unknown'}`);

  // Startup Telegram message
  const symCount = marketContext?.meta?.symbolCount || UNIVERSE.length;
  const fullTier = marketContext?.tiers?.full?.join(', ') || 'n/a';
  const calRisk = marketContext?.calendar?.risk || '?';

  await sendTelegram(
    `☀️ <b>HELIOS FUSION BOT v2</b>\n━━━━━━━━━━━━━━━━━━━\n` +
    `${SIGNALS.length} signals | ${symCount} symbols\n` +
    `Regime: ${regime?.regime || '?'} | Calendar: ${calRisk}\n` +
    `Tiers: full=[${fullTier}]\n` +
    `${CONFIG.maxTradesPerDay} max trades | Kelly ×${sizer.kellyFraction.toFixed(2)}\n` +
    `Equity: $${equity.toFixed(2)}`, { parseMode: 'HTML' });

  // Wait until session start
  while (getHHMM() < CONFIG.sessionStart && !isShuttingDown) {
    await sleep(CONFIG.pollIntervalMs);
  }
  if (isShuttingDown) { log('Shutdown before session start'); return cleanup(); }

  // ── Main loop ─────────────────────────────────────────────────────
  while (!isShuttingDown) {
    const now = getHHMM();
    pollCounter++;
    log(`--- cycle ${pollCounter} | time ${now} ---`);

    // Hard exit
    if (now >= CONFIG.hardExit) {
      log('Hard exit — closing all positions');
      await closeAllPositions();
      break;
    }

    // Refresh regime periodically (cache avoids redundant API calls)
    try { currentRegime = await detectRegime(); } catch {}

    // Daily loss limit
    try {
      const acct = await retry(() => withTimeout(() => alpaca.getAccount(), CONFIG.apiTimeoutMs, 'getAccount'));
      const eq = parseFloat(acct.portfolio_value);
      if (CONFIG.dailyLossLimitPct > 0 && dailyPnl < 0 && (Math.abs(dailyPnl) / eq * 100) > CONFIG.dailyLossLimitPct) {
        log(`Daily loss limit hit: $${dailyPnl.toFixed(2)}`, 'error');
        await closeAllPositions();
        break;
      }
    } catch {}

    // Rebalance signal weights
    if (learner.shouldRebalance(sessionStartMs)) {
      for (const s of SIGNALS) fusion.setWeight(s.name, learner.getWeight(s.name));
      learner.markRebalanced();
    }

    // Monitor positions
    await monitorPositions();

    const openCount = [...activePositions.values()].filter(p => p.status !== 'closed').length;

    // Portfolio snapshot
    if (openCount > 0) {
      try {
        const acct = await retry(() => withTimeout(() => alpaca.getAccount(), CONFIG.apiTimeoutMs, 'getAccount'));
        const eq = parseFloat(acct.portfolio_value);
        const totalUnrealized = [...activePositions.values()]
          .filter(p => p.status === 'filled')
          .reduce((sum, p) => sum + (p.pnl ?? 0), 0);
        log(`Portfolio: equity $${eq.toFixed(2)} | unrealized $${totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)} | daily $${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}`);
      } catch {}
    }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // New entries (during session window, no open positions, under trade limit)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (now >= CONFIG.sessionStart && now < CONFIG.sessionEnd && openCount === 0 && tradesToday < CONFIG.maxTradesPerDay) {
      const existingSymbols = await getExistingPositionSymbols();
      const eligibleSymbols = UNIVERSE.filter(sym => {
        if (activePositions.has(sym) && activePositions.get(sym).status !== 'closed') return false;
        if (cooldowns.has(sym) && Date.now() < cooldowns.get(sym)) return false;
        if (existingSymbols.has(sym)) return false;
        if (!shouldScanToday(sym)) return false;
        return true;
      });
      if (eligibleSymbols.length === 0) {
        await sleep(CONFIG.pollIntervalMs);
        continue; // nothing to scan this cycle
      }

      const data = await fetchSymbolData(eligibleSymbols);

      for (const sym of eligibleSymbols) {
        const d = data[sym];
        if (!d?.bars || d.bars.length < 5 || !d.dailyATR || d.dailyATR < CONFIG.minATR) continue;

        // Build pair prices
        const pairPrices = {};
        for (const [o, od] of Object.entries(data))
          if (o !== sym) pairPrices[o] = od.price;

        const ctx = {
          symbol: sym, bars: d.bars, dailyATR: d.dailyATR,
          price: d.price, prevClose: d.prevClose, pivots: d.pivots,
          pairData: { prices: pairPrices },
          marketContext,   // ✨ v2.0: pass full context to signals
          regime: currentRegime?.regime,
        };

        const results = [];
        for (const sig of SIGNALS) {
          try {
            let res = sig.analyze(ctx);
            if (!res) res = { direction: 0, strength: 0, reason: 'no response' };
            // Regime gate: block counter-trend in strong regimes
            const reg = currentRegime?.regime;
            if (reg === 'trending_up' && res.direction < 0) {
              res = { ...res, direction: 0, strength: 0, reason: `counter-trend blocked (${reg})` };
            }
            if (reg === 'trending_down' && res.direction > 0) {
              res = { ...res, direction: 0, strength: 0, reason: `counter-trend blocked (${reg})` };
            }
            results.push({ ...res, name: sig.name });
          }
          catch (e) { results.push({ direction: 0, strength: 0, name: sig.name, reason: 'error' }); }
        }

        const decision = fusion.fuse(results);
        if (decision.trade) {
          const detailStr = decision.details
            .filter(x => x.direction !== 0)
            .map(x => `${x.name}:${x.direction > 0 ? 'L' : 'S'}(${(x.strength*100).toFixed(0)}%)`).join(' ');

          const price   = d.bars[d.bars.length - 1].close;

          // ── ATR expansion-aware stops ──
          const atrExp = marketContext?.symbols?.[sym]?.volatility?.atrExpansion;
          let stopMult = 1.0, targMult = 2.0; // defaults (wider for noise resilience)
          if (atrExp?.regime === 'compressing') {
            stopMult = 0.75; targMult = 1.5; // tighter on coiled springs
          } else if (atrExp?.regime === 'expanding') {
            stopMult = 1.3; targMult = 2.5; // wider on wild swings
          }

          const stopPr  = decision.direction > 0 ? price - d.dailyATR * stopMult : price + d.dailyATR * stopMult;
          const targPr  = decision.direction > 0 ? price + d.dailyATR * targMult : price - d.dailyATR * targMult;
          const stopDist = Math.abs(price - stopPr);

          const acct = await retry(() => withTimeout(() => alpaca.getAccount(), CONFIG.apiTimeoutMs, 'getAccount'));
          const eq  = parseFloat(acct.portfolio_value);

          // Regime-aware sizing
          const sizeMult = regimeSizeMultiplier(regime);
          const qty = Math.floor(sizer.calculate(eq, price, stopDist, decision.strength) * sizeMult);

          const rr = Math.abs(targPr - price) / stopDist;
          log(`${sym} ${decision.direction > 0 ? 'LONG' : 'SHORT'}: Comp=${decision.composite.toFixed(2)} | RR=${rr.toFixed(1)}:1 | Qty=${qty} | Stop×${stopMult} | Signals: ${detailStr}`);

          const order = await placeOrder(sym,
            decision.direction > 0 ? 'long' : 'short',
            price, parseFloat(stopPr.toFixed(2)), parseFloat(targPr.toFixed(2)), qty);

          if (order) {
            activePositions.set(sym, {
              orderId: order.id,
              status: order.status === 'dry_run' ? 'dry_run' : 'pending',
              side: decision.direction > 0 ? 'long' : 'short',
              sideSign: decision.direction > 0 ? 1 : -1,
              entryPrice: price, fillPrice: null, qty,
              composite: decision.composite, signalDetails: detailStr,
              signalDetailsList: decision.details,
              placedAt: Date.now(), filledAt: null,
            });

            await sendTelegram(
              `☀️ ${decision.direction > 0 ? '🟢 LONG' : '🔴 SHORT'} <b>${sym}</b>\n` +
              `Comp: ${decision.composite.toFixed(2)} | Strength: ${(decision.strength*100).toFixed(0)}%\n` +
              `Signals: ${detailStr}\n` +
              `Entry: $${price.toFixed(2)} | Qty: ${qty}\n` +
              `SL: $${stopPr.toFixed(2)} | TP: $${targPr.toFixed(2)}\n` +
              `${atrExp ? `Vol: ${atrExp.regime} ×${stopMult} stop` : ''}`,
              { parseMode: 'HTML' });

            // Learner recording moved to exit (recordLearnerExit) for P&L accuracy

            lastSymbolScanMs.set(sym, Date.now()); // mark as scanned
            break; // one entry per cycle
          }
        }
      }
    }

    // After session end, only monitor
    if (now >= CONFIG.sessionEnd && now < CONFIG.hardExit && openCount > 0) {
      log(`Session ended (${CONFIG.sessionEnd}) — monitoring ${openCount} open position(s)`);
    }

    await sleep(CONFIG.pollIntervalMs);
  }

  // EOD
  const tradeResults = [...activePositions.entries()].map(([sym, pos]) => ({
    symbol: sym, side: pos.side,
    entryPrice: pos.fillPrice ?? pos.entryPrice,
    pnl: pos.pnl ?? 0,
  }));
  await sendEODReport(tradeResults);
  return cleanup();
}

// ─── EOD Report ──────────────────────────────────────────────────────
async function sendEODReport(trades) {
  if (!telegramEnabled()) return;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(0) : '0';

  let msg = `☀️ <b>HELIOS EOD REPORT</b>\n━━━━━━━━━━━━━━━━━━━\n`;
  msg += `Trades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}\n`;
  msg += `Win rate: ${winRate}% | P&L: $${totalPnl.toFixed(2)}\n`;

  // Add learner stats
  const stats = learner.getStats();
  if (Object.keys(stats).length > 0) {
    msg += `\n<b>Signal Performance:</b>\n`;
    for (const [name, s] of Object.entries(stats)) {
      msg += `• ${name}: w=${s.weight.toFixed(2)} | ${s.correctCalls}/${s.totalCalls} correct\n`;
    }
  }

  if (trades.length > 0) {
    msg += `\n`;
    for (const t of trades) {
      const tag = t.pnl >= 0 ? '🟢' : '🔴';
      msg += `${tag} ${t.symbol} ${t.side?.toUpperCase()} — $${t.pnl.toFixed(2)}\n`;
    }
  }
  await sendTelegram(msg, { parseMode: 'HTML' });
}

// ─── Cleanup ─────────────────────────────────────────────────────────
async function cleanup() {
  // Save learner state for next session
  try {
    const state = learner.toJSON();
    fs.writeFileSync(LEARNER_STATE_PATH, JSON.stringify(state, null, 2));
    log(`Learner state saved → ${LEARNER_STATE_PATH}`);
  } catch (e) {
    log(`Failed to save learner state: ${e.message}`, 'error');
  }

  // Save final log
  saveLog();

  // Orphan detection
  if (!DRY_RUN) {
    try {
      const allAlpacaPositions = await retry(() => withTimeout(() => alpaca.getPositions(), CONFIG.apiTimeoutMs, 'getPositions'));
      const trackedSymbols = new Set([...activePositions.keys()]);
      const orphaned = allAlpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
      if (orphaned.length > 0) {
        log(`WARNING: ${orphaned.length} orphaned position(s): ${orphaned.map(p => p.symbol).join(', ')}`, 'error');
        await sendTelegram(
          `⚠️ <b>ORPHANED POSITIONS</b>\n${orphaned.map(p => `${p.symbol}: ${p.qty} shares @ $${parseFloat(p.avg_entry_price).toFixed(2)}`).join('\n')}`,
          { parseMode: 'HTML' });
      }
    } catch {}
  }

  log(`Done — ${tradesToday} trades completed, P&L $${dailyPnl.toFixed(2)}`);
  await tgShutdown('Helios Fusion Bot off');
}

// ─── Graceful shutdown ───────────────────────────────────────────────
async function handleShutdown(signal) {
  log(`${signal} received, initiating graceful shutdown...`);
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Save learner state mid-shutdown too
  try {
    const state = learner.toJSON();
    fs.writeFileSync(LEARNER_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {}

  saveLog();
  try { await closeAllPositions(); } catch {}

  // Orphan detection at shutdown
  try {
    const allAlpacaPositions = await retry(() => withTimeout(() => alpaca.getPositions(), CONFIG.apiTimeoutMs, 'getPositions'));
    const trackedSymbols = new Set([...activePositions.keys()]);
    const orphaned = allAlpacaPositions.filter(p => !trackedSymbols.has(p.symbol));
    if (orphaned.length > 0) {
      log(`WARNING: ${orphaned.length} orphaned: ${orphaned.map(p => p.symbol).join(', ')}`, 'error');
      await sendTelegram(`⚠️ <b>ORPHANED:</b> ${orphaned.map(p => p.symbol).join(', ')}`, { parseMode: 'HTML' });
    }
  } catch {}

  await tgShutdown('Helios Fusion Bot off');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log(`Uncaught: ${err.message}\n${err.stack}`, 'error');
  try { const state = learner.toJSON(); fs.writeFileSync(LEARNER_STATE_PATH, JSON.stringify(state)); } catch {}
  tgError(`☀️ Helios crashed: ${err.message}`);
  saveLog();
  process.exit(1);
});

// ─── Persistence ─────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'helios-log.json');
let saveInterval;
function startPeriodicSave() {
  saveInterval = setInterval(() => {
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(tradeLog, null, 2)); } catch {}
  }, 5 * 60 * 1000);
}
function saveLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(tradeLog, null, 2)); } catch {}
}

main().catch(e => { log(`FATAL: ${e.message}`, 'error'); process.exit(1); });
