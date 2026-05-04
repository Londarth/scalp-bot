// scripts/lib/kelly-sizer.js
// Kelly-criterion position sizing: scales with signal conviction
// and recent win rate. kellyFraction limits max risk per trade.

export class KellySizer {
  constructor({
    kellyFraction = 0.25,
    maxRiskPct = 2,
    minPositionUSD = 100,
    basePositionPct = 3,
  } = {}) {
    this.kellyFraction = kellyFraction;
    this.maxRiskPct = maxRiskPct;
    this.minPositionUSD = minPositionUSD;
    this.basePositionPct = basePositionPct;
    this.recentTrades = [];  // [{win: bool, strength: number}]
    this.maxHistory = 20;
  }

  recordTrade(win, strength) {
    this.recentTrades.push({ win, strength });
    if (this.recentTrades.length > this.maxHistory)
      this.recentTrades.shift();
  }

  getRecentWinRate() {
    if (this.recentTrades.length === 0) return 0.50;
    const wins = this.recentTrades.filter(t => t.win).length;
    return wins / this.recentTrades.length;
  }

  /**
   * Compute Kelly-optimal risk fraction.
   * kelly = winRate - ((1 - winRate) / (avgWin / avgLoss))
   * Capped by maxRiskPct, scaled by kellyFraction for half-Kelly safety.
   */
  kellyFractionFn(winRate, avgWin, avgLoss) {
    if (avgLoss <= 0) return this.maxRiskPct / 100;
    const odds = avgWin / avgLoss;
    const raw = winRate - ((1 - winRate) / odds);
    return Math.max(0, Math.min(this.maxRiskPct / 100,
                    raw * this.kellyFraction));
  }

  /**
   * Calculate shares for a fusion trade.
   * @param {number} equity — portfolio value
   * @param {number} price — entry price per share
   * @param {number} stopDistance — distance to stop in dollars
   * @param {number} fusionStrength — 0-1 composite conviction
   */
  calculate(equity, price, stopDistance, fusionStrength) {
    const winRate = this.getRecentWinRate();

    // Assume ~2:1 R:R structure (0.8 ATR target / 0.4 ATR stop)
    const avgWin = 0.016, avgLoss = 0.008;
    const kelly = this.kellyFractionFn(winRate, avgWin, avgLoss);

    // Blend base allocation + Kelly signal, scaled by fusion conviction
    const riskPct = ((this.basePositionPct / 100) + kelly) / 2 *
                     Math.max(0.25, fusionStrength);
    const riskDollars = Math.min(
      equity * riskPct,
      equity * (this.maxRiskPct / 100)
    );

    let shares;
    if (stopDistance > 0.001) {
      shares = Math.floor(riskDollars / stopDistance);
    } else {
      shares = Math.floor(riskDollars / price);
    }

    if (shares * price < this.minPositionUSD) {
      shares = Math.ceil(this.minPositionUSD / price);
    }

    return Math.max(1, shares);
  }
}
