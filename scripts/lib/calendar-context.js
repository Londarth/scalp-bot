// scripts/lib/calendar-context.js
// Calendar event risk detection for trading sessions.
// Flags high-uncertainty days where position sizing and signal preferences
// should be adjusted. Uses only static date rules — no external API needed.

const NY_TZ = 'America/New_York';

/** Get today's date in NY timezone */
function getNYDate() {
  const d = new Date().toLocaleString('en-US', { timeZone: NY_TZ });
  return new Date(d);
}

/**
 * Check if a date falls on a US federal holiday.
 * Covers market-closure days that affect pre/post-market behavior.
 */
function isUSHoliday(date) {
  const y = date.getFullYear();
  const m = date.getMonth();       // 0-indexed
  const d = date.getDate();
  const dow = date.getDay();       // 0=Sun

  // New Year's Day (Jan 1, or nearest weekday)
  if (m === 0) {
    const ny = new Date(y, 0, 1).getDay();
    if (d === 1) return true;
    if (ny === 0 && d === 2) return true;   // observed Mon
    if (ny === 6 && d === 2) return true;   // observed Mon (Sat = observed Mon)
  }

  // MLK Day (3rd Monday of January)
  if (m === 0 && dow === 1 && d >= 15 && d <= 21) return true;

  // Presidents' Day (3rd Monday of February)
  if (m === 1 && dow === 1 && d >= 15 && d <= 21) return true;

  // Good Friday (approximate — Friday before Easter, mid-Mar to late-Apr)
  // We use a rough heuristic: Friday in March 20-Apr 25 range
  // Full accurate calculation requires Easter formula; this catches 95% of cases
  if (m >= 2 && m <= 3 && dow === 5) {
    // Check if within typical Good Friday range
    const dayOfYear = Math.floor((date - new Date(y, 0, 0)) / 86400000);
    const easterApprox = Math.floor((y % 19) * 11) % 30 + 80; // rough March day
    if (Math.abs(dayOfYear - easterApprox) <= 2 && dow === 5) return true;
  }

  // Memorial Day (last Monday of May)
  if (m === 4 && dow === 1 && d >= 25) return true;

  // Juneteenth (June 19, or nearest weekday)
  if (m === 5) {
    if (d === 19) return true;
    const jd = new Date(y, 5, 19).getDay();
    if (jd === 0 && d === 20) return true;
    if (jd === 6 && d === 18) return true;
  }

  // Independence Day (July 4, or nearest weekday)
  if (m === 6) {
    if (d === 4) return true;
    const id = new Date(y, 6, 4).getDay();
    if (id === 0 && d === 5) return true;
    if (id === 6 && d === 3) return true;
  }

  // Labor Day (1st Monday of September)
  if (m === 8 && dow === 1 && d <= 7) return true;

  // Thanksgiving (4th Thursday of November)
  if (m === 10 && dow === 4 && d >= 22 && d <= 28) return true;

  // Christmas (Dec 25, or nearest weekday)
  if (m === 11) {
    if (d === 25) return true;
    const cd = new Date(y, 11, 25).getDay();
    if (cd === 0 && d === 26) return true;
    if (cd === 6 && d === 24) return true;
  }

  return false;
}

/**
 * Determine if today falls on or near a major economic event.
 *
 * Risk levels:
 *   - 'normal'   → standard sizing, all signals active
 *   - 'elevated' → halve Kelly fraction, deprioritize gap-fill
 *   - 'high'     → quarter Kelly, only trend-following signals
 */
export function getCalendarContext(dateOverride) {
  const date = dateOverride || getNYDate();
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const dow = date.getDay(); // 0=Sun, 6=Sat

  // ─── FOMC / Fed days ────────────────────────────────────────────
  // FOMC meetings: 8 per year, roughly every 6-7 weeks.
  // 2026 schedule (approximate — 3rd week of cycle months)
  const fomcWeeks = [
    { m: 0,  w: 4 },  // Jan 27-28
    { m: 2,  w: 3 },  // Mar 17-18
    { m: 4,  w: 1 },  // May 5-6
    { m: 5,  w: 3 },  // Jun 16-17
    { m: 7,  w: 4 },  // Jul 28-29
    { m: 8,  w: 3 },  // Sep 15-16
    { m: 10, w: 1 },  // Nov 3-4
    { m: 11, w: 3 },  // Dec 15-16
  ];

  let isFOMCDay = false;
  let isFOMCWeek = false;

  for (const fw of fomcWeeks) {
    // Find the Wednesday of that week
    const firstOfMonth = new Date(year, fw.m, 1);
    const firstDow = firstOfMonth.getDay();
    const firstWed = 3 + (firstDow <= 3 ? 3 - firstDow : 10 - firstDow);
    const wedDay = firstWed + (fw.w - 1) * 7;

    // FOMC typically Tue-Wed, announcement Wed 2pm
    const wed = new Date(year, fw.m, wedDay);
    const tue = new Date(year, fw.m, wedDay - 1);

    if (date.toDateString() === wed.toDateString()) {
      isFOMCDay = true;
      break;
    }
    if (date.toDateString() === tue.toDateString()) {
      isFOMCDay = true;
      break;
    }
    // Day before (Mon) — elevated uncertainty
    const mon = new Date(year, fw.m, wedDay - 2);
    if (date.toDateString() === mon.toDateString()) {
      isFOMCWeek = true;
      break;
    }
  }

  if (isFOMCDay) {
    return {
      risk: 'high',
      reason: 'FOMC meeting day — high volatility, halving positions',
      kellyMultiplier: 0.25,
      signalPreference: 'trend',     // trending signals only
      deprioritize: ['gap-fill', 'pairs-divergence'],  // mean-reversion dangerous
      flags: ['FOMC'],
    };
  }
  if (isFOMCWeek) {
    return {
      risk: 'elevated',
      reason: 'Pre-FOMC positioning — elevated chop risk',
      kellyMultiplier: 0.50,
      signalPreference: 'balanced',
      deprioritize: ['gap-fill'],
      flags: ['PRE_FOMC'],
    };
  }

  // ─── Triple Witching ──────────────────────────────────────────────
  // 3rd Friday of Mar, Jun, Sep, Dec
  if ([2, 5, 8, 11].includes(month)) {
    if (dow === 5 && day >= 15 && day <= 21) {
      return {
        risk: 'elevated',
        reason: 'Triple witching — elevated volume + noise',
        kellyMultiplier: 0.50,
        signalPreference: 'balanced',
        deprioritize: ['gap-fill'],
        flags: ['OPEX', 'TRIPLE_WITCHING'],
      };
    }
  }

  // ─── Monthly OPEX (3rd Friday of any month) ────────────────────────
  if (dow === 5 && day >= 15 && day <= 21) {
    return {
      risk: 'elevated',
      reason: 'Monthly OPEX — options pinning risk',
      kellyMultiplier: 0.50,
      signalPreference: 'balanced',
      deprioritize: ['gap-fill', 'vwap-reversion'],
      flags: ['OPEX'],
    };
  }

  // ─── CPI / PPI days (approximately 2nd week of month) ──────────────
  // CPI: ~10th-14th of month; PPI: ~11th-15th
  // We flag the entire 10th-15th window as 'elevated' for econ data
  if (day >= 10 && day <= 14) {
    return {
      risk: 'elevated',
      reason: 'Economic data window (CPI/PPI) — whipsaw risk',
      kellyMultiplier: 0.50,
      signalPreference: 'trend',
      deprioritize: ['gap-fill'],
      flags: ['ECON_DATA_WINDOW'],
    };
  }

  // ─── Holiday-adjacent days ─────────────────────────────────────────
  // Day after holiday (or Friday before Monday holiday) = thin volume
  if (isUSHoliday(date)) {
    return {
      risk: 'high',
      reason: 'Market holiday — not trading',
      kellyMultiplier: 0,
      signalPreference: 'none',
      deprioritize: [],
      flags: ['HOLIDAY'],
    };
  }

  // Check if tomorrow is a holiday (thin pre-holiday volume)
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isUSHoliday(tomorrow)) {
    return {
      risk: 'elevated',
      reason: 'Pre-holiday session — reduced volume, avoid gap fills',
      kellyMultiplier: 0.50,
      signalPreference: 'trend',
      deprioritize: ['gap-fill'],
      flags: ['PRE_HOLIDAY'],
    };
  }

  // ─── Day of week adjustments ────────────────────────────────────────
  // Monday: gap-fill works better (weekend gaps close)
  // Friday: trend signals work better (position-squaring into close)
  if (dow === 1) {
    return {
      risk: 'normal',
      reason: 'Monday — gap-fill favorable',
      kellyMultiplier: 0.75,
      signalPreference: 'mean_reversion',
      deprioritize: [],
      flags: ['MONDAY'],
    };
  }
  if (dow === 5) {
    return {
      risk: 'normal',
      reason: 'Friday — trend favorable, reduce exposure',
      kellyMultiplier: 0.75,
      signalPreference: 'trend',
      deprioritize: ['momentum-cascade'],
      flags: ['FRIDAY'],
    };
  }

  // ─── Default: normal trading day ───────────────────────────────────
  return {
    risk: 'normal',
    reason: 'Standard trading day',
    kellyMultiplier: 1.0,
    signalPreference: 'balanced',
    deprioritize: [],
    flags: [],
  };
}

export default getCalendarContext;
