// scripts/lib/online-learner.js
// Online adaptive weighting: tracks each signal's P&L contribution
// and adjusts fusion weights upward for well-performing signals.
// Uses exponential moving average of trade outcomes per signal.
//
// v1.1: Added toJSON() / fromJSON() persistence so the learner's state
//       survives between sessions — the pre-market scan loads yesterday's
//       state and passes it to Helios as warm-start priors.

export class OnlineLearner {
  constructor({ decayRate = 0.05, rebalanceInterval = 30,
                regressionStrength = 0.3, initialState = null } = {}) {
    this.decayRate = decayRate;
    this.rebalanceInterval = rebalanceInterval;       // minutes between rebalances
    this.regressionStrength = regressionStrength;     // pull toward 1.0 baseline
    this.signalScores = new Map();   // name → { pnl, count, correctCalls, totalCalls, score }
    this.lastRebalance = 0;

    // Warm-start: load prior state if provided
    if (initialState) {
      this._loadState(initialState);
    }
  }

  /** Load state from a plain object (from JSON or pre-market scan) */
  _loadState(state) {
    if (!state || typeof state !== 'object') return;
    const entries = state.signalScores || state;
    for (const [name, s] of Object.entries(entries)) {
      this.signalScores.set(name, {
        pnl: parseFloat(s.pnl) || 0,
        count: parseInt(s.count) || 0,
        correctCalls: parseInt(s.correctCalls) || 0,
        totalCalls: parseInt(s.totalCalls) || 0,
        score: parseFloat(s.score) || (s.totalCalls > 0 ? s.correctCalls / s.totalCalls : 0.5),
      });
    }
  }

  /**
   * Record a trade that this signal voted on.
   * @param {string} signalName
   * @param {number} pnlContribution — realized P&L (positive = good, negative = bad)
   * @param {number} direction — what the signal called (1=long, -1=short, 0=neutral)
   */
  record(signalName, pnlContribution, direction) {
    if (!this.signalScores.has(signalName)) {
      this.signalScores.set(signalName, {
        pnl: 0, count: 0, correctCalls: 0, totalCalls: 0,
      });
    }
    const s = this.signalScores.get(signalName);
    s.pnl += pnlContribution;
    s.count++;
    if (direction !== 0) {
      s.totalCalls++;
      // Correct call: signal direction matches trade outcome
      // Long (direction=1) is correct when pnl > 0
      // Short (direction=-1) is correct when pnl > 0 (we profit from decline)
      if (pnlContribution > 0) {
        s.correctCalls++;
      }
    }
    s.score = s.totalCalls > 0 ? s.correctCalls / s.totalCalls : 0.5;
  }

  /**
   * Compute current weight for a signal.
   * Blend: P&L performance (60%) + directional accuracy (40%).
   * Regressed toward 1.0 to prevent runaway weight drift.
   */
  getWeight(signalName) {
    const s = this.signalScores.get(signalName);
    if (!s || s.count < 3) return 1.0; // not enough data yet

    // P&L score: $0.02 avg profit per trade → 2.0 weight
    const avgPnl = s.count > 0 ? s.pnl / s.count : 0;
    const pnlScore = Math.max(0.1, Math.min(5.0, 1 + avgPnl / 0.02));

    // Win-rate score: 50% → 1.0, 100% → 1.5
    const winScore = 0.5 + s.score * 1.0;

    const raw = pnlScore * 0.6 + winScore * 0.4;
    const regressed = raw * (1 - this.regressionStrength) +
                      1.0 * this.regressionStrength;

    return parseFloat(Math.max(0.1, regressed).toFixed(3));
  }

  /** Check if it's time to rebalance weights */
  shouldRebalance(sessionStartMs) {
    const elapsed = (Date.now() - sessionStartMs) / 60000;
    if (elapsed < this.rebalanceInterval) return false;
    if (Date.now() - this.lastRebalance < 60000) return false;
    return true;
  }

  markRebalanced() { this.lastRebalance = Date.now(); }

  getStats() {
    const stats = {};
    for (const [name, s] of this.signalScores) {
      stats[name] = { ...s, weight: this.getWeight(name) };
    }
    return stats;
  }

  /** Serialize current state for persisting across sessions */
  toJSON() {
    const signalScores = {};
    for (const [name, s] of this.signalScores) {
      signalScores[name] = {
        pnl: s.pnl,
        count: s.count,
        correctCalls: s.correctCalls,
        totalCalls: s.totalCalls,
        score: s.score,
        weight: this.getWeight(name),
      };
    }
    return {
      signalScores,
      lastRebalance: this.lastRebalance,
      savedAt: new Date().toISOString(),
    };
  }

  /** Factory: create from a JSON state object */
  static fromJSON(state) {
    return new OnlineLearner({ initialState: state });
  }
}
