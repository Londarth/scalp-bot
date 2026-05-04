import dotenv from 'dotenv';
dotenv.config();
import Alpaca from '@alpacahq/alpaca-trade-api';

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  feed: 'iex',
});

async function test() {
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const acct = await alpaca.getAccount();
      console.log(`getAccount #${i+1} OK in ${Date.now()-start}ms equity=${acct.portfolio_value}`);
    } catch(e) {
      console.log(`getAccount #${i+1} ERR in ${Date.now()-start}ms:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const pos = await alpaca.getPositions();
      console.log(`getPositions #${i+1} OK in ${Date.now()-start}ms count=${pos.length}`);
    } catch(e) {
      console.log(`getPositions #${i+1} ERR in ${Date.now()-start}ms:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const resp = await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=5Min&start=2026-05-04T09:25:00-04:00&end=2026-05-04T16:30:00-04:00&limit=78&feed=iex`, {
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
      });
      const data = await resp.json();
      console.log(`fetch #${i+1} OK in ${Date.now()-start}ms bars=${data.bars?.SPY?.length || 0}`);
    } catch(e) {
      console.log(`fetch #${i+1} ERR in ${Date.now()-start}ms:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('DONE');
}
test();
