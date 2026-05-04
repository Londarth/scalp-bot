#!/usr/bin/env node
// scripts/helios-analytics.js
// Performance analytics for Helios Fusion sessions.
// Computes: Sharpe, drawdown, signal attribution, win/loss metrics.
// Reads helios-bot PM2 logs and outputs a structured report.

import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ─── Parse trades from a log file ──────────────────────────────────
function parseTrades(logContent) {
  const lines = logContent.split('\n').filter(Boolean);
  const trades = [];
  let currentTrade = null;

  for (const line of lines) {
    // Entry order placed
    const orderMatch = line.match(/\[TRD\].*?(\w+)\s+(LONG|SHORT)\s+order\s+placed.*?qty=(\d+)\s+@\s+limit\s+\$([\d.]+)\s+\|\s+SL=\$([\d.]+)\s+TP=\$([\d.]+)/);
    if (orderMatch) {
      if (currentTrade && currentTrade.result === 'pending') {
        currentTrade.result = 'unknown';
        trades.push(currentTrade);
      }
      currentTrade = {
        symbol: orderMatch[1],
        side: orderMatch[2],
        qty: parseInt(orderMatch[3]),
        entryPrice: parseFloat(orderMatch[4]),
        stopPrice: parseFloat(orderMatch[5]),
        targetPrice: parseFloat(orderMatch[6]),
        orderId: (line.match(/Order:\s+([\w-]+)/) || [])[1] || 'unknown',
        entryTime: line.substring(0, 19),
        result: 'pending',
        fillPrice: null,
        pnl: 0,
        exitReason: '',
        signals: line.match(/Signals:\s*(.*)/)?.[1] || '',
      };
    }

    // Fill
    const fillMatch = line.match(/\[TRD\].*?FILLED\s+at\s+\$([\d.]+)/);
    if (fillMatch && currentTrade) {
      currentTrade.fillPrice = parseFloat(fillMatch[1]);
      const slippageBps = (line.match(/(\d+\.?\d*)\s+bps/) || [])[1];
      currentTrade.slippageBps = slippageBps ? parseFloat(slippageBps) : 0;
    }

    // Close / exit
    const closeMatch = line.match(/\[TRD\].*?Position\s+closed\s+\(([\w\s]+)\).*?P&L:\s*\$?([-\d.]+)/);
    if (closeMatch && currentTrade) {
      currentTrade.exitReason = closeMatch[1].trim();
      currentTrade.pnl = parseFloat(closeMatch[2]);
      currentTrade.result = currentTrade.pnl > 0 ? 'win' : currentTrade.pnl < 0 ? 'loss' : 'breakeven';
      currentTrade.exitTime = line.substring(0, 19);
      trades.push(currentTrade);
      currentTrade = null;
    }

    // Done line with daily P&L
    const doneMatch = line.match(/Done.*?P&L\s+\$?([-\d.]+)/);
    if (doneMatch) {
      if (currentTrade) {
        currentTrade.dailyPnl = parseFloat(doneMatch[1]);
        if (currentTrade.result === 'pending') {
          currentTrade.result = currentTrade.dailyPnl > 0 ? 'win' : currentTrade.dailyPnl < 0 ? 'loss' : 'breakeven';
          currentTrade.pnl = currentTrade.dailyPnl;
        }
        trades.push(currentTrade);
        currentTrade = null;
      }
    }
  }

  return trades;
}

// ─── Compute Sharpe ratio ────────────────────────────────────────
function computeSharpe(pnlArray, riskFreeRate = 0.02) {
  if (pnlArray.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < pnlArray.length; i++) {
    const r = pnlArray[i] - pnlArray[i - 1];
    returns.push(r);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  if (variance === 0) return 0;
  const dailySharpe = (mean - (riskFreeRate / 252)) / Math.sqrt(variance);
  return parseFloat((dailySharpe * Math.sqrt(252)).toFixed(2)); // annualized
}

// ─── Compute max drawdown ────────────────────────────────────────
function computeDrawdown(equityCurve) {
  let peak = equityCurve[0];
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat(maxDD.toFixed(2));
}

// ─── Signal attribution ──────────────────────────────────────────
function attributeSignals(trades) {
  const signalStats = {};
  for (const trade of trades) {
    if (!trade.signals) continue;
    const sigs = trade.signals.split(' ').filter(Boolean);
    for (const sig of sigs) {
      const [name, dirStr] = sig.split(':');
      if (!signalStats[name]) {
        signalStats[name] = { count: 0, correct: 0, totalPnl: 0, strength: [] };
      }
      const pctMatch = dirStr?.match(/\((\d+)%\)/);
      const pct = pctMatch ? parseInt(pctMatch[1]) : 50;
      signalStats[name].count++;
      signalStats[name].strength.push(pct);
      if (trade.result === 'win') signalStats[name].correct++;
      signalStats[name].totalPnl += trade.pnl;
    }
  }

  // Format
  const result = {};
  for (const [name, s] of Object.entries(signalStats)) {
    const avgStrength = s.strength.length > 0
      ? s.strength.reduce((a, b) => a + b, 0) / s.strength.length
      : 0;
    result[name] = {
      trades: s.count,
      correct: s.correct,
      accuracy: s.count > 0 ? (s.correct / s.count * 100).toFixed(0) + '%' : 'n/a',
      totalPnl: parseFloat(s.totalPnl.toFixed(2)),
      avgStrength: parseFloat(avgStrength.toFixed(0)) + '%',
    };
  }
  return result;
}

// ─── Aggregate across log files ──────────────────────────────────
function aggregateLogs() {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('helios-bot-out') && f.endsWith('.log'))
    .sort();

  if (files.length === 0) return { trades: [], equityCurve: [], days: 0 };

  const allTrades = [];
  const equityCurve = [];
  let runningEquity = parseFloat(process.env.BACKTEST_CAPITAL || '100000');

  for (const file of files) {
    const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
    const trades = parseTrades(content);

    // Extract daily equity from account snapshots
    for (const line of content.split('\n')) {
      const eqMatch = line.match(/Equity:\s+\$?([\d.]+)/);
      if (eqMatch && !line.includes('Kelly')) { // skip the startup equity line
        runningEquity = parseFloat(eqMatch[1]);
        equityCurve.push(runningEquity);
      }
    }

    allTrades.push(...trades);
  }

  // If no equity curve from account snapshots, build from P&L
  if (equityCurve.length === 0 && allTrades.length > 0) {
    const baseEquity = parseFloat(process.env.BACKTEST_CAPITAL || '100000');
    let eq = baseEquity;
    equityCurve.push(baseEquity);
    for (const t of allTrades) {
      eq += t.pnl;
      equityCurve.push(eq);
    }
  }

  return { trades: allTrades, equityCurve, days: files.length };
}

// ─── Main ────────────────────────────────────────────────────────
function main() {
  const { trades, equityCurve, days } = aggregateLogs();

  if (trades.length === 0) {
    console.log('No trades found in session logs. Run backtest for performance data.');
    return { trades: 0, equity: 'N/A', pnl: 0, winRate: 'N/A', sharpe: 0, drawdown: 0, signalAttribution: {} };
  }

  const wins = trades.filter(t => t.result === 'win').length;
  const losses = trades.filter(t => t.result === 'loss').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins > 0 ? trades.filter(t => t.result === 'win').reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? trades.filter(t => t.result === 'loss').reduce((s, t) => s + Math.abs(t.pnl), 0) / losses : 0;

  const dailyPnls = [];
  let dailySum = 0;
  for (const t of trades) {
    dailySum += t.pnl;
    dailyPnls.push(dailySum);
  }

  const sharpe = computeSharpe(dailyPnls);
  const drawdown = computeDrawdown(equityCurve);
  const signalAttr = attributeSignals(trades);
  const finalEquity = equityCurve[equityCurve.length - 1] || 0;
  const totalReturn = finalEquity > 0 ? (totalPnl / (finalEquity - totalPnl) * 100) : 0;

  const report = {
    sessions: days,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length * 100).toFixed(0) + '%' : '0%',
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : 0,
    sharpe,
    maxDrawdown: drawdown,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    equity: parseFloat(finalEquity.toFixed(2)),
    equityCurve,
    signalAttribution: signalAttr,
  };

  // Text report
  const tag = report.totalPnl >= 0 ? '🟢' : '🔴';
  let text = `📊 <b>HELIOS ANALYTICS</b> (${days} sessions)\n━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `${tag} P&L: $${report.totalPnl.toFixed(2)} | ${report.winRate} WR\n`;
  text += `Sharpe: ${report.sharpe} | MaxDD: ${report.maxDrawdown}%\n`;
  text += `Avg W: $${report.avgWin.toFixed(2)} | Avg L: $${report.avgLoss.toFixed(2)} | PF: ${report.profitFactor}\n`;

  if (Object.keys(signalAttr).length > 0) {
    text += `\n<b>Signal Attribution:</b>\n`;
    for (const [name, s] of Object.entries(signalAttr)) {
      const st = s.totalPnl >= 0 ? '🟢' : '🔴';
      text += `${st} ${name}: ${s.accuracy} acc (${s.trades}) | $${s.totalPnl.toFixed(2)}\n`;
    }
  }

  console.log(text);
  return report;
}

const report = main();
if (process.env.HERMES_CRON_SESSION) {
  console.log('\n##ANALYTICS_JSON##');
  console.log(JSON.stringify(report, null, 2));
}
