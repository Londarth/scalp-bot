// scripts/lib/fusion-engine.js
// Aggregates multiple independent signals into a single trade decision.
// Consensus rule: composite > entryThreshold AND minVotes agree.
// Dynamic per-signal weights from OnlineLearner (default equal weight = 1.0).

export class FusionEngine {
  constructor({ entryThreshold = 0.25, minVotes = 2, baseWeight = 1.0 } = {}) {
    this.entryThreshold = entryThreshold;
    this.minVotes = minVotes;
    this.weights = new Map();       // signalName → weight (set by OnlineLearner)
    this.baseWeight = baseWeight;
    this.lastResults = null;
  }

  /** Set dynamic weight for a signal (called during rebalance) */
  setWeight(signalName, weight) {
    this.weights.set(signalName, Math.max(0.1, Math.min(5.0, weight)));
  }

  getWeight(signalName) {
    return this.weights.get(signalName) ?? this.baseWeight;
  }

  /**
   * Fuse multiple signal results into a single trade decision.
   * @param {Array<{direction, strength, reason, name}>} signals
   * @returns {{ trade: boolean, direction: 1|-1|0, composite: number,
   *             strength: number, votes: {long,short,total,agree}, details: [] }}
   */
  fuse(signals) {
    let weightedSum = 0;
    let totalWeight = 0;
    let longVotes = 0;
    let shortVotes = 0;
    const details = [];

    for (const sig of signals) {
      if (!sig.direction || !sig.strength) {
        details.push({
          name: sig.name || 'unknown', direction: 0, strength: 0,
          weight: 0, contribution: 0, reason: sig.reason || '',
        });
        continue;
      }

      const name = sig.name || 'unknown';
      const weight = this.getWeight(name);
      const contribution = sig.direction * sig.strength * weight;

      weightedSum += contribution;
      totalWeight += weight;
      if (sig.direction === 1) longVotes++;
      else if (sig.direction === -1) shortVotes++;

      details.push({
        name, direction: sig.direction, strength: sig.strength,
        weight, contribution: parseFloat(contribution.toFixed(4)),
        reason: sig.reason || '',
      });
    }

    const composite = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const absComposite = Math.abs(composite);
    const direction = composite > 0 ? 1 : composite < 0 ? -1 : 0;
    const agreeingVotes = direction > 0 ? longVotes : direction < 0 ? shortVotes : 0;
    const totalVotes = longVotes + shortVotes;

    // Entry: composite exceeds threshold AND at least minVotes agree
    const trade = absComposite >= this.entryThreshold && agreeingVotes >= this.minVotes;

    // Strength: map composite to 0-1 range (0.6 composite → 1.0 strength)
    const rawStrength = trade ? Math.min(1, parseFloat((absComposite / 0.6).toFixed(3))) : 0;

    // Confidence penalty: low conviction on many weak signals → reduce strength
    const votePenetration = totalVotes / signals.length; // 0 = all neutral, 1 = all voting
    const confidencePenalty = totalVotes >= this.minVotes
      ? Math.pow(rawStrength, 1 + 0.3 * Math.max(0, votePenetration - 0.5))
      : rawStrength;
    const strength = trade ? parseFloat(Math.max(0.1, confidencePenalty).toFixed(3)) : 0;

    this.lastResults = { details, weightedSum, totalWeight, longVotes, shortVotes };

    return {
      trade,
      direction: trade ? direction : 0,
      composite: parseFloat(composite.toFixed(4)),
      strength,
      votes: { long: longVotes, short: shortVotes, total: totalVotes, agree: agreeingVotes },
      details,
    };
  }
}
