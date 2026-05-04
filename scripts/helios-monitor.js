#!/usr/bin/env node
// scripts/helios-monitor.js
// Health check + config drift detection + daily performance analytics
// Runs as a Hermes cron job. Reports issues via the bot's Telegram module.
//
// Checks:
//   - PM2: is helios-bot stopped when it should be? Did it start?
//   - Disk: over 85%?
//   - Config drift: do cron times match session times?
//   - Performance: extract P&L from recent logs

import dotenv from 'dotenv';
dotenv.config();
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const LOG_DIR = path.join(__dirname, '..', 'logs');

function log(msg) { console.log(`[monitor] ${new Date().toISOString()} ${msg}`); }

// ─── PM2 Health Check ────────────────────────────────────────────
function checkPM2() {
  try {
    const out = execSync('pm2 jlist 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
    if (!out.trim()) { log('PM2 not running'); return [{ name: 'pm2-daemon', status: 'dead', pid: 0 }]; }
    const procs = JSON.parse(out);
    return procs.map(p => ({ name: p.name, status: p.pm2_env?.status || 'unknown', pid: p.pid, uptime: p.pm2_env?.pm_uptime }));
  } catch (e) {
    log(`PM2 check failed: ${e.message}`);
    return [{ name: 'pm2-daemon', status: 'error', pid: 0 }];
  }
}

// ─── Disk Check ──────────────────────────────────────────────────
function checkDisk() {
  try {
    const out = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf8', timeout: 3000 }).trim();
    const pct = parseInt(out.replace('%', ''));
    return { usage: pct, warning: pct > 85 };
  } catch {
    return { usage: 0, warning: false };
  }
}

// ─── Config Drift Check ──────────────────────────────────────────
function checkConfigDrift() {
  const issues = [];

  // Read crontab
  let cronLine;
  try {
    const crontab = execSync('crontab -l', { encoding: 'utf8', timeout: 3000 });
    cronLine = crontab.split('\n').find(l => l.includes('helios-bot') && l.includes('pm2 start'));
  } catch { return [{ severity: 'error', msg: 'Cannot read crontab' }]; }

  // Parse cron minute + hour
  const cronMatch = cronLine?.match(/(\d+)\s+(\d+)\s+/);
  const cronStartHHMM = cronMatch ? parseInt(cronMatch[1]) + parseInt(cronMatch[2]) * 100 : null;

  // Read session start from env
  const sessionStart = parseInt(process.env.HELIOS_SESSION_START || '1005');
  const sessionStartMin = Math.floor(sessionStart / 100) * 60 + (sessionStart % 100); // e.g. 1005 → 605

  // Expected cron time: sessionStart - 10 minutes (bot needs time to load context)
  // e.g. sessionStart=1005: scan at 9:50, bot start at 9:55, wait until 10:05
  // Handle HHMM wrap: (1005 - 10) → {hour:9, min:55} → 0955
  const startMin = Math.floor(sessionStart / 100) * 60 + (sessionStart % 100);
  const expectedMin = startMin - 10;
  const expectedCronH = Math.floor(expectedMin / 60);
  const expectedCronM = expectedMin % 60;
  const expectedCron = expectedCronH * 100 + expectedCronM;
  const cronVal = cronStartHHMM || 0;
  const diff = Math.abs(cronVal - expectedCron);

  if (diff > 15) { // allow ±15 min tolerance
    issues.push({
      severity: 'warning',
      msg: `Config drift: cron starts helios at ${cronStartHHMM?.toString().padStart(4, '0') ?? '?'} but session is ${String(sessionStart).padStart(4, '0')}. Cron should be ~${Math.floor(sessionStart/100)}:${String(sessionStart%100-5).padStart(2,'0')}`,
    });
  }

  // Check if .env has all required Helios vars
  const required = ['HELIOS_SESSION_START', 'HELIOS_SESSION_END', 'HELIOS_HARD_EXIT',
                     'HELIOS_ENTRY_THRESHOLD', 'HELIOS_MIN_VOTES', 'HELIOS_MAX_TRADES',
                     'HELIOS_KELLY', 'HELIOS_BASE_POS_PCT'];
  for (const key of required) {
    if (!process.env[key]) {
      issues.push({ severity: 'error', msg: `Missing env var: ${key}` });
    }
  }

  return issues;
}

// ─── Performance from session log ────────────────────────────────
function analyzeRecentLog() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const logFiles = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('helios-bot-out') && f.endsWith('.log'));
    if (logFiles.length === 0) return null;

    // Read most recent log file
    const latest = logFiles.sort().reverse()[0];
    const content = fs.readFileSync(path.join(LOG_DIR, latest), 'utf8');
    const lines = content.split('\n').filter(Boolean);

    // Extract trades
    const trades = lines.filter(l => l.includes('[TRD]')).length;
    const fills = lines.filter(l => l.includes('FILLED')).length;
    const closes = lines.filter(l => l.includes('closed')).length;

    // Extract P&L
    let totalPnl = 0;
    for (const line of lines) {
      const pnlMatch = line.match(/P&L:\s*\$?([-\d.]+)/);
      if (pnlMatch) totalPnl += parseFloat(pnlMatch[1]);
    }

    // Count cycles (entries scanned)
    const cycles = lines.filter(l => l.includes('cycle')).length;

    return {
      source: latest,
      lines: lines.length,
      trades,
      fills,
      closes,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      cycles,
      tradeRate: cycles > 0 ? (trades / cycles * 100).toFixed(1) : '0',
    };
  } catch (e) {
    log(`Log analysis failed: ${e.message}`);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  log('=== Helios Health Check ===');

  // 1. PM2
  const pm2Procs = checkPM2();
  const heliosProc = pm2Procs.find(p => p.name === 'helios-bot');
  if (!heliosProc) log('ERROR: helios-bot not found in PM2');
  else log(`PM2: helios-bot → ${heliosProc.status} (pid ${heliosProc.pid})`);

  // 2. Disk
  const disk = checkDisk();

  // 3. Config drift
  const drift = checkConfigDrift();

  // 4. Performance
  const perf = analyzeRecentLog();

  // ─── Build report ───
  let report = '☀️ <b>HELIOS HEALTH</b>\n━━━━━━━━━━━━━━━━━━━━━\n';

  // PM2 status
  const statusEmoji = heliosProc?.status === 'online' ? '🟢' :
                      heliosProc?.status === 'stopped' ? '⚫' : '🔴';
  report += `\n${statusEmoji} <b>PM2:</b> ${heliosProc?.name ?? 'helios-bot'} → ${heliosProc?.status ?? 'not found'}`;

  // Disk
  if (disk.warning) {
    report += `\n⚠️ <b>Disk:</b> ${disk.usage}% used`;
  }

  // Config issues
  if (drift.length > 0) {
    report += `\n\n⚠️ <b>Config Issues:</b>`;
    for (const d of drift) {
      report += `\n• ${d.msg}`;
    }
  }

  // Performance
  if (perf) {
    report += `\n\n📊 <b>Performance (${perf.source}):</b>`;
    report += `\n• ${perf.lines} log lines | ${perf.cycles} scan cycles`;
    report += `\n• ${perf.trades} trades | ${perf.fills} fills | ${perf.closes} closes`;
    const tag = perf.totalPnl >= 0 ? '🟢' : '🔴';
    report += `\n• ${tag} P&L: $${perf.totalPnl.toFixed(2)}`;
    if (perf.cycles > 0 && perf.trades === 0) {
      report += `\n⚠️ Zero trades in ${perf.cycles} cycles — thresholds may be too high`;
    }
  } else {
    report += `\n\n📊 No session log found today`;
  }

  // Summary verdict
  const issues = [];
  if (!heliosProc || heliosProc.status === 'stopped') issues.push('Bot is stopped');
  if (disk.warning) issues.push(`Disk at ${disk.usage}%`);
  if (drift.some(d => d.severity === 'error')) issues.push('Config errors');
  if (perf && perf.cycles > 0 && perf.trades === 0) issues.push('Zero trades');

  report += `\n━━━━━━━━━━━━━━━━━━━━━`;
  if (issues.length === 0) {
    report += `\n✅ All clear`;
  } else {
    report += `\n🔴 Issues: ${issues.join(', ')}`;
  }

  console.log(report);
  return { pm2Procs, disk, drift, perf, issues, report };
}

// When run directly, output to stdout (Hermes cron captures this)
main().then(r => {
  if (r.report) console.log(`\n##TELEGRAM_REPORT##\n${r.report}`);
}).catch(e => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
