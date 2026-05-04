#!/usr/bin/env node
// scripts/helios-docs-sync.js
// Auto-generates CLAUDE.md and .env.example from running code + .env file.
// Run whenever files change or before a session to prevent stale documentation.

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─── Read .env keys (masked) ──────────────────────────────────
function getEnvKeys() {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  return lines.map(l => {
    const [key, val] = l.split('=');
    if (!key) return null;
    const masked = val?.length > 10 ? val.slice(0, 3) + '...' + val.slice(-4) : (val || '');
    return { key: key.trim(), value: masked };
  }).filter(Boolean);
}

// ─── Generate .env.example ────────────────────────────────────
function generateEnvExample(envKeys) {
  let content = '';
  const sections = {
    'Alpaca': ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_PAPER'],
    'Telegram': ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    'Universe': ['UNIVERSE'],
    'Helios Session (ET)': ['HELIOS_SESSION_START', 'HELIOS_SESSION_END', 'HELIOS_HARD_EXIT',
                            'HELIOS_POLL_MS', 'HELIOS_CONTEXT_STALE_MIN'],
    'Helios Fusion Engine': ['HELIOS_ENTRY_THRESHOLD', 'HELIOS_MIN_VOTES'],
    'Helios Risk Management': ['HELIOS_MAX_TRADES', 'HELIOS_KELLY', 'HELIOS_BASE_POS_PCT',
                                'MAX_EQUITY_PCT', 'DAILY_LOSS_LIMIT_PCT', 'UNFILLED_TIMEOUT_MIN',
                                'HELIOS_COOLDOWN_MIN'],
    'Scanner': ['SCANNER_TOP_N', 'WATCHLIST_PATH', 'MARKET_CONTEXT_PATH'],
    'Filters': ['MIN_ATR'],
    'API': ['API_TIMEOUT_MS'],
    'Dry Run': ['DRY_RUN'],
    'Backtest': ['SLIPPAGE_BPS', 'COMMISSION_PER_SHARE', 'BACKTEST_DAYS',
                 'BACKTEST_CAPITAL', 'BT_STOP_MULT', 'BT_TARG_MULT'],
  };

  for (const [section, keys] of Object.entries(sections)) {
    content += `# ─── ${section} ───\n`;
    for (const key of keys) {
      const entry = envKeys.find(e => e.key === key);
      content += `${key}=${entry ? (['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'TELEGRAM_BOT_TOKEN'].includes(key) ? '***' : entry.value) : 'YOUR_' + key}\n`;
    }
    content += '\n';
  }

  return content;
}

// ─── Generate CLAUDE.md ───────────────────────────────────────
function generateCLAUDEMD() {
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter(f => f.endsWith('.js') && !f.startsWith('.'))
    .sort();

  const libs = fs.readdirSync(path.join(ROOT, 'scripts/lib'))
    .filter(f => f.endsWith('.js'))
    .sort();

  const signals = fs.readdirSync(path.join(ROOT, 'scripts/signals'))
    .filter(f => f.endsWith('.js') && !f.includes('.bak'))
    .sort();

  const tests = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.js'))
    .sort();

  let md = `# CLAUDE.md\n\n`;
  md += `Helios Fusion — multi-signal algorithmic trading bot for Alpaca (Paper).\n`;
  md += `Runs on Hetzner VPS, controlled via Telegram, started by cron on trading days.\n\n`;

  md += `## Architecture\n\n`;
  md += `\`\`\`\n`;
  md += `Phone (Telegram) ←→ telegram-ctl.js (systemd)\n`;
  md += `                       ↓ PM2 commands\n`;
  md += `pre-market-scan.js (9:50 ET) → market-context.json\n`;
  md += `                       ↓\n`;
  md += `helios-bot.js (${process.env.HELIOS_SESSION_START || '1005'}–${process.env.HELIOS_SESSION_END || '1110'} ET)\n`;
  md += `                       ↓ REST API\n`;
  md += `         Alpaca API ←→ Market data + order execution\n`;
  md += `\`\`\`\n\n`;

  md += `## Commands\n\n`;
  md += `\`\`\`bash\n`;
  md += `npm start          # node scripts/helios-bot.js\n`;
  md += `npm run pre-market # Pre-market scanner\n`;
  md += `npm run backtest   # Helios Fusion backtest\n`;
  md += `npm test           # Run all test suites\n`;
  md += `node scripts/helios-monitor.js    # Health check\n`;
  md += `node scripts/helios-analytics.js  # Performance report\n`;
  md += `node scripts/helios-optimize.js   # Config sweep\n`;
  md += `\`\`\`\n\n`;

  md += `## Key Files\n\n`;
  md += `| File | Purpose |\n`;
  md += `|------|--------|\n`;
  md += `| scripts/helios-bot.js | Main Helios Fusion trading bot |\n`;
  md += `| scripts/pre-market-scan.js | Pre-market scanner (writes market-context.json) |\n`;
  md += `| scripts/telegram-ctl.js | Telegram command listener (systemd) |\n`;
  md += `| scripts/telegram.js | Unified Telegram module |\n`;
  md += `| scripts/helios-backtest.js | Backtest engine |\n`;
  md += `| scripts/helios-monitor.js | Health + config drift check |\n`;
  md += `| scripts/helios-analytics.js | Performance analytics (Sharpe, drawdown) |\n`;
  md += `| scripts/helios-optimize.js | Post-session config optimizer |\n`;
  md += `\n`;

  md += `### Signals (${signals.length})\n\n`;
  for (const s of signals) {
    md += `- \`scripts/signals/${s}\`\n`;
  }
  md += `\n### Library (${libs.length})\n\n`;
  for (const l of libs) {
    md += `- \`scripts/lib/${l}\`\n`;
  }
  md += `\n`;

  md += `## Current Config\n\n`;
  md += `- Session: ${process.env.HELIOS_SESSION_START || '1005'}–${process.env.HELIOS_SESSION_END || '1110'} ET, hard exit ${process.env.HELIOS_HARD_EXIT || '1130'}\n`;
  md += `- Threshold: composite >${process.env.HELIOS_ENTRY_THRESHOLD || '0.25'}, ≥${process.env.HELIOS_MIN_VOTES || '2'} votes\n`;
  md += `- Kelly: ×${process.env.HELIOS_KELLY || '0.25'}, base pos: ${process.env.HELIOS_BASE_POS_PCT || '2'}%\n`;
  md += `- Max trades: ${process.env.HELIOS_MAX_TRADES || '6'}, loss limit: ${process.env.DAILY_LOSS_LIMIT_PCT || '3'}%\n`;
  md += `- Paper: ${process.env.ALPACA_PAPER || 'true'}\n`;
  md += `\n---\nAuto-generated by helios-docs-sync on ${new Date().toISOString()}\n`;

  return md;
}

// ─── Main ──────────────────────────────────────────────────────
function main() {
  const envKeys = getEnvKeys();

  const envExample = generateEnvExample(envKeys);
  fs.writeFileSync(path.join(ROOT, '.env.example'), envExample);
  console.log('✅ .env.example synced');

  const claudeMd = generateCLAUDEMD();
  fs.writeFileSync(path.join(ROOT, 'CLAUDE.md'), claudeMd);
  console.log('✅ CLAUDE.md synced');
  console.log(`   Scripts: ${fs.readdirSync(path.join(ROOT, 'scripts')).filter(f=>f.endsWith('.js')).length} | Lib: ${fs.readdirSync(path.join(ROOT, 'scripts/lib')).length} | Signals: ${fs.readdirSync(path.join(ROOT, 'scripts/signals')).filter(f=>f.endsWith('.js')).length} | Tests: ${fs.readdirSync(path.join(ROOT, 'tests')).length}`);
}

main();
