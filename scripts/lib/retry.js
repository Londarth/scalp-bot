// scripts/lib/retry.js

function defaultShouldRetry(err) {
  const msg = err?.message || '';
  const match = msg.match(/\b(\d{3})\b/);
  if (match) {
    const status = parseInt(match[1], 10);
    // Do not retry client errors except 429 (rate limit)
    if (status >= 400 && status < 500 && status !== 429) return false;
  }
  return true;
}

export async function retry(fn, { maxRetries = 3, baseDelay = 1000, shouldRetry = defaultShouldRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await new Promise(r => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

export async function withTimeout(promiseFn, ms, label = 'operation') {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promiseFn(), timeout]);
}
