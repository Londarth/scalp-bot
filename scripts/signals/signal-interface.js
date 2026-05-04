// scripts/signals/signal-interface.js
// Standard contract for all signal modules.
//
// Every signal must export: { name, version, analyze(ctx) → {direction, strength} }
//
// Context passed to analyze():
//   { symbol, bars, dailyATR, price, vwap, pivots, prevClose, regime, pairData }
//
// Return value:
//   { direction: 1|-1|0, strength: 0.0-1.0, reason: string, metadata?: {} }
//   0 = neutral (no signal)

export function validateSignal(sig) {
  if (!sig || typeof sig !== 'object') return { valid: false, error: 'not an object' };
  if (!sig.name || typeof sig.name !== 'string') return { valid: false, error: 'missing .name' };
  if (!sig.version) return { valid: false, error: 'missing .version' };
  if (typeof sig.analyze !== 'function') return { valid: false, error: 'missing .analyze()' };
  return { valid: true };
}

export function validateResult(result) {
  if (!result || typeof result !== 'object') return { valid: false, error: 'not an object' };
  const dir = result.direction;
  if (dir !== 1 && dir !== -1 && dir !== 0)
    return { valid: false, error: `invalid direction: ${dir}` };
  if (typeof result.strength !== 'number' || result.strength < 0 || result.strength > 1)
    return { valid: false, error: `invalid strength: ${result.strength}` };
  return { valid: true };
}

export function neutral(signalName, reason = '') {
  return { direction: 0, strength: 0,
    reason: reason || `${signalName}: neutral` };
}

export function long(signalName, strength, reason = '', metadata = {}) {
  return {
    direction: 1,
    strength: Math.min(1, Math.max(0, strength)),
    reason: reason || `${signalName}: LONG`,
    ...metadata,
  };
}

export function short(signalName, strength, reason = '', metadata = {}) {
  return {
    direction: -1,
    strength: Math.min(1, Math.max(0, strength)),
    reason: reason || `${signalName}: SHORT`,
    ...metadata,
  };
}
