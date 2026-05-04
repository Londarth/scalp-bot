#!/usr/bin/env node
// scripts/helios-optimize.js
// Quick config sweep — tests 5-8 combos max, runs under 120s.

import dotenv from 'dotenv';
dotenv.config({path:'/root/scalp-bot/.env', override:true});
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_SCRIPT = path.join(__dirname, 'helios-backtest.js');
const ROOT = path.join(__dirname, '..');

function runBT({ entryThreshold, minVotes, stopMult, targMult }) {
  const env = {
    ...process.env,
    HELIOS_ENTRY_THRESHOLD: String(entryThreshold),
    HELIOS_MIN_VOTES: String(minVotes),
    BT_STOP_MULT: String(stopMult),
    BT_TARG_MULT: String(targMult),
  };
  try {
    const out = execSync(`node ${BACKTEST_SCRIPT}`, { encoding:'utf8', timeout:90000, env, cwd:ROOT });
    let pnl=0, trades=0, wr=0;
    for (const l of out.split('\n')) {
      const pm = l.match(/Net P&L:\s+\$?([-\d.]+)/); if (pm) pnl = parseFloat(pm[1]);
      const tm = l.match(/Total trades:\s+(\d+)/); if (tm) trades = parseInt(tm[1]);
      const wm = l.match(/Win rate:\s+(\d+\.?\d*)%/); if (wm) wr = parseFloat(wm[1]);
    }
    // Score: prefer positive P&L, decent win rate, enough trades
    const s = trades >= 4 ? pnl * 0.7 + (wr - 40) * 10 + trades * 5 : -Infinity;
    return { entryThreshold, minVotes, stopMult, targMult, pnl, trades, wr, score:Math.round(s) };
  } catch(e) { return { entryThreshold, minVotes, stopMult, targMult, pnl:0, trades:0, wr:0, score:-Infinity, error:e.message?.slice(0,100) }; }
}

console.log('🔧 Config sweep (8 combos)...\n');

const combos = [
  { entryThreshold: 0.20, minVotes: 2, stopMult: 1.0, targMult: 2.0 },
  { entryThreshold: 0.25, minVotes: 2, stopMult: 1.0, targMult: 2.0 }, // current
  { entryThreshold: 0.30, minVotes: 2, stopMult: 1.0, targMult: 2.0 },
  { entryThreshold: 0.25, minVotes: 1, stopMult: 1.0, targMult: 2.0 },
  { entryThreshold: 0.25, minVotes: 3, stopMult: 1.0, targMult: 2.0 },
  { entryThreshold: 0.25, minVotes: 2, stopMult: 0.75, targMult: 1.5 },
  { entryThreshold: 0.25, minVotes: 2, stopMult: 1.3, targMult: 2.5 },
  { entryThreshold: 0.20, minVotes: 1, stopMult: 1.0, targMult: 2.0 },
];

const results = [];
for (const c of combos) {
  const tag = `ET=${c.entryThreshold} MV=${c.minVotes} SM=${c.stopMult} TM=${c.targMult}`;
  console.log(`  Testing ${tag}...`);
  const r = runBT(c);
  results.push(r);
  const st = r.trades > 0 ? `${r.trades}T $${r.pnl.toFixed(0)} ${r.wr}%WR score=${r.score}` : '❌';
  console.log(`    → ${st}`);
}

// Best
results.sort((a,b) => b.score - a.score);
const best = results[0];
const cur = combos.find(c => c.entryThreshold===0.25 && c.minVotes===2 && c.stopMult===1.0 && c.targMult===2.0);
const curResult = results.find(r => r.entryThreshold===0.25 && r.minVotes===2 && r.stopMult===1.0 && r.targMult===2.0);

console.log(`\n${'═'.repeat(50)}`);
console.log(`🏆 BEST: ET=${best.entryThreshold} MV=${best.minVotes} SM=${best.stopMult} TM=${best.targMult} → ${best.trades}T $${best.pnl.toFixed(0)} WR=${best.wr}%`);
if (best.score > (curResult?.score || -Infinity) && best !== curResult) {
  console.log(`   Current: ET=0.25 MV=2 → ${curResult?.trades}T $${curResult?.pnl?.toFixed(0)}`);
  console.log(`   📝 SUGGESTED: HELIOS_ENTRY_THRESHOLD=${best.entryThreshold} HELIOS_MIN_VOTES=${best.minVotes} BT_STOP_MULT=${best.stopMult} BT_TARG_MULT=${best.targMult}`);
} else {
  console.log('   ✅ Current config is optimal');
}
