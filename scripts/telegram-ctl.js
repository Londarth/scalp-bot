import dotenv from 'dotenv';
dotenv.config();

import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { sendTelegram, MAIN_BUTTONS, escapeHtml, TG_API, TG_CHAT_ID, TG_TOKEN } from './telegram.js';

// Re-export escapeHtml for test compatibility
export { escapeHtml };

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOT_NAME = 'helios';
const LOG_PATH = join(__dirname, 'helios-log.json');
const SNAPSHOT_PATH = join(__dirname, 'account-snapshot.json');
const ORPHANED_PATH = join(__dirname, 'orphaned-positions.json');

const ALPACA_BASE = process.env.ALPACA_PAPER === 'false'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
};

let lastUpdateId = 0;
let lastStartCmd = 0;
let pollFailCount = 0;
const START_COOLDOWN_MS = 10000;
const POLL_MAX_BACKOFF_MS = 30000;

// ─── Pure functions (exported for testing) ───

export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  return parts[0].split('@')[0].toLowerCase();
}

export function isAuthorized(chatId) {
  return String(chatId) === String(TG_CHAT_ID);
}

async function answerCallbackQuery(callbackQueryId) {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (e) { /* ignore */ }
}

// ─── PM2 helpers ───

function pm2(cmd) {
  return new Promise((resolve, reject) => {
    exec(`pm2 ${cmd}`, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(err);
      else resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
    });
  });
}

async function getBotStatus() {
  try {
    const { stdout } = await pm2('describe helios-bot');
    const statusMatch = stdout.match(/status\s*│\s*(\w+)/);
    const uptimeMatch = stdout.match(/uptime\s*│\s*(.+)/);
    return {
      online: statusMatch ? statusMatch[1] === 'online' : false,
      status: statusMatch ? statusMatch[1] : 'not found',
      uptime: uptimeMatch ? uptimeMatch[1].trim() : 'N/A',
    };
  } catch {
    return { online: false, status: 'not found', uptime: 'N/A' };
  }
}

async function readTradeLog() {
  try {
    const data = await readFile(LOG_PATH, 'utf8');
    const log = JSON.parse(data);
    return log.slice(-10);
  } catch {
    return [];
  }
}

async function readSnapshot() {
  try {
    const data = await readFile(SNAPSHOT_PATH, 'utf8');
    const snap = JSON.parse(data);
    const age = Date.now() - snap.ts;
    const ageMin = Math.round(age / 60000);
    return { ...snap, ageMin };
  } catch {
    return null;
  }
}

// ─── Command handlers ───

async function handleStart() {
  const now = Date.now();
  if (now - lastStartCmd < START_COOLDOWN_MS) {
    await sendTelegram('⏳ Bot start already requested recently — please wait', { buttons: MAIN_BUTTONS });
    return;
  }
  lastStartCmd = now;
  try {
    await pm2('start ecosystem.config.cjs --only helios-bot');
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    await sendTelegram(`⚡️ <b>Helios Bot started</b>\nMode: ${paper}\nWindow: 10:05–11:15 ET`, { buttons: MAIN_BUTTONS });
  } catch (err) {
    await sendTelegram(`❌ Failed to start bot: ${err.message}`, { buttons: MAIN_BUTTONS });
  }
}

async function handleStop() {
  try {
    await pm2('stop helios-bot');
    await sendTelegram('🛑 <b>Helios Bot stopped</b>', { buttons: MAIN_BUTTONS });
  } catch (err) {
    await sendTelegram(`❌ Failed to stop bot: ${err.message}`, { buttons: MAIN_BUTTONS });
  }
}

async function handleStatus() {
  const [botStatus, tradeLog, snapshot] = await Promise.all([
    getBotStatus(),
    readTradeLog(),
    readSnapshot(),
  ]);

  let msg = botStatus.online ? '🟢 <b>Helios Bot is running</b>' : '🔴 <b>Bot is stopped</b>';
  if (botStatus.online) {
    const paper = process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE';
    msg += `\nMode: ${paper}`;
    msg += `\nUptime: ${botStatus.uptime}`;
  }

  // Live account data from snapshot
  if (snapshot) {
    const paper = snapshot.mode || 'PAPER';
    const dryTag = snapshot.dryRun ? ' DRY' : '';
    msg += `\n\n💰 <b>Account</b> (${paper}${dryTag})`;
    msg += `\nEquity: <b>$${Number(snapshot.equity).toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>`;
    msg += `\nCash: $${Number(snapshot.cash).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    if (snapshot.positions && snapshot.positions.length > 0) {
      msg += `\n\n📊 <b>Open Positions</b>`;
      for (const p of snapshot.positions) {
        const pnlSign = p.unrealizedPl >= 0 ? '+' : '';
        const pnlPct = p.entryPrice ? ((p.unrealizedPl / (p.entryPrice * p.qty)) * 100).toFixed(1) : '0.0';
        msg += `\n• <b>${p.symbol}</b> ${p.side.toUpperCase()} ${p.qty}×$${Number(p.entryPrice).toFixed(2)}`;
        msg += ` | ${pnlSign}$${Number(p.unrealizedPl).toFixed(2)} (${pnlSign}${pnlPct}%)`;
        msg += `\n  Now: $${Number(p.currentPrice).toFixed(2)} → $${Number(p.targetPrice).toFixed(2)} / SL $${Number(p.stopPrice).toFixed(2)}`;
      }
    } else {
      msg += `\n\n📋 No open positions`;
    }

    if (snapshot.orders && snapshot.orders.length > 0) {
      for (const o of snapshot.orders) {
        msg += `\n\n⏳ <b>Pending Order</b>`;
        msg += `\n${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ $${Number(o.price).toFixed(2)}`;
        msg += `\nSL: $${Number(o.stop).toFixed(2)} | TP: $${Number(o.target).toFixed(2)}`;
      }
    }

    msg += `\n\n<i>Snapshot ${snapshot.ageMin}m old</i>`;
  }

  if (tradeLog.length > 0) {
    msg += '\n\n<b>Recent activity:</b>';
    for (const entry of tradeLog.slice(-5)) {
      const prefix = entry.level === 'error' ? '❌' : entry.level === 'trade' ? '📊' : 'ℹ️';
      msg += `\n${prefix} ${escapeHtml(entry.msg)}`;
    }
  } else {
    msg += '\n\n<i>No recent activity</i>';
  }

  await sendTelegram(msg, { buttons: MAIN_BUTTONS });
}

async function handleHelp() {
  await sendTelegram(
    '🤖 <b>Helios Bot Commands</b>\n\n' +
    '/start — Start Helios bot\n' +
    '/stop — Stop Helios bot\n' +
    '/status — Show bot status and recent trades\n' +
    '/help — Show this message\n\n' +
    '⚠️ Orphaned position buttons appear automatically when detected.',
    { buttons: MAIN_BUTTONS }
  );
}

// ─── Orphaned position helpers ───

async function readOrphanedPositions() {
  try {
    const data = await readFile(ORPHANED_PATH, 'utf8');
    const parsed = JSON.parse(data);
    // Only return if recent (within 30 minutes)
    if (Date.now() - parsed.ts < 30 * 60 * 1000) {
      return parsed.positions;
    }
  } catch {}
  return [];
}

async function handleCloseOrphaned() {
  const positions = await readOrphanedPositions();
  if (positions.length === 0) {
    await sendTelegram('No orphaned positions to close.', { buttons: MAIN_BUTTONS });
    return;
  }
  let closed = 0, failed = 0;
  for (const p of positions) {
    try {
      const side = p.side === 'long' ? 'sell' : 'buy';
      const resp = await fetch(`${ALPACA_BASE}/v2/orders`, {
        method: 'POST',
        headers: { ...ALPACA_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: p.symbol,
          qty: parseFloat(p.qty),
          side,
          type: 'market',
          time_in_force: 'day',
        }),
      });
      if (resp.ok) {
        closed++;
      } else {
        failed++;
        console.error(`Close failed for ${p.symbol}: ${resp.status}`);
      }
    } catch (e) {
      failed++;
      console.error(`Close orphaned ${p.symbol} error: ${e.message}`);
    }
  }
  // Clean up orphaned file
  try { const { unlink } = await import('fs/promises'); await unlink(ORPHANED_PATH); } catch {}
  await sendTelegram(
    `✅ Closed ${closed}/${positions.length} orphaned position(s)${failed > 0 ? ` (${failed} failed)` : ''}`,
    { buttons: MAIN_BUTTONS }
  );
}

async function handleKeepOrphaned() {
  const positions = await readOrphanedPositions();
  // Clean up orphaned file
  try { const { unlink } = await import('fs/promises'); await unlink(ORPHANED_PATH); } catch {}
  await sendTelegram(
    `✅ Keeping ${positions.length} orphaned position(s) as-is`,
    { buttons: MAIN_BUTTONS }
  );
}

// ─── Command router ───

const COMMANDS = {
  '/start': handleStart,
  '/stop': handleStop,
  '/status': handleStatus,
  '/help': handleHelp,
  '/close_orphaned': handleCloseOrphaned,
  '/keep_orphaned': handleKeepOrphaned,
};

async function handleMessage(msg) {
  if (!isAuthorized(msg.chat.id)) {
    console.log(`Ignoring message from unauthorized chat: ${msg.chat.id}`);
    return;
  }
  const cmd = parseCommand(msg.text);
  if (!cmd) return;
  const handler = COMMANDS[cmd];
  if (handler) {
    console.log(`Command: ${cmd} from ${msg.chat.id}`);
    await handler();
  }
}

// ─── Polling loop ───

async function poll() {
  try {
    const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(35000) });
    if (!resp.ok) {
      console.error(`Poll error: ${resp.status}`);
      pollFailCount++;
      return;
    }
    const data = await resp.json();
    if (!data.ok || !data.result) {
      pollFailCount++;
      return;
    }

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        const cb = update.callback_query;
        if (isAuthorized(cb.message?.chat?.id)) {
          const handler = COMMANDS[cb.data];
          if (handler) {
            console.log(`Callback: ${cb.data} from ${cb.from?.id}`);
            await handler();
          }
        }
        await answerCallbackQuery(cb.id);
      }
    }
    pollFailCount = 0;
  } catch (err) {
    console.error(`Poll failed: ${err.message}`);
    pollFailCount++;
  }
}

async function main() {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(1);
  }

  console.log('🤖 Helios Bot Controller started');
  console.log(`Chat ID: ${TG_CHAT_ID}`);
  console.log('Listening for commands: /start, /stop, /status, /help');

  while (true) {
    await poll();
    if (pollFailCount > 0) {
      const delay = Math.min(1000 * Math.pow(2, Math.min(pollFailCount - 1, 5)), POLL_MAX_BACKOFF_MS);
      console.log(`Poll failure #${pollFailCount}, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}