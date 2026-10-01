'use strict';

/**
 * Readiness answers one question for a router or deployment: can this process safely serve its
 * configured profile right now? It is deliberately separate from liveness, which only says the
 * process is running and must not depend on anything outside it.
 *
 * Every check runs in parallel under its own timeout, so one hung dependency cannot stall the
 * probe past its deadline. Results never carry error messages: dependency errors routinely
 * embed URLs, hosts, or credentials, and readiness endpoints are unauthenticated.
 */

const DEFAULT_TIMEOUT_MS = 3_000;

function withTimeout(promiseFactory, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('readiness check timed out');
      error.readinessTimeout = true;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(promiseFactory), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

async function runCheck(check, defaultTimeoutMs, now) {
  const startedAt = now();
  const required = check.required !== false;
  try {
    await withTimeout(check.check, check.timeoutMs ?? defaultTimeoutMs);
    return { name: check.name, required, status: 'ok', durationMs: now() - startedAt };
  } catch (error) {
    return {
      name: check.name,
      required,
      status: 'unavailable',
      reason: error && error.readinessTimeout ? 'timeout' : 'failed',
      durationMs: now() - startedAt,
    };
  }
}

async function evaluateReadiness(checks, options = {}) {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const dependencies = await Promise.all(
    checks.map((check) => runCheck(check, defaultTimeoutMs, now)),
  );

  return {
    ready: dependencies.every((dependency) => !dependency.required || dependency.status === 'ok'),
    dependencies,
  };
}

/**
 * Remembers a successful probe for `ttlMs` so a costly or rate-limited dependency (for example a
 * KMS key lookup) is not called on every probe. Failures are never cached, and concurrent probes
 * share one in-flight call.
 */
function cacheSuccessfulCheck(check, ttlMs, now = Date.now) {
  let okUntil = 0;
  let inFlight = null;

  return async () => {
    if (now() < okUntil) {
      return;
    }

    inFlight ??= Promise.resolve()
      .then(check)
      .then(() => {
        okUntil = now() + ttlMs;
      })
      .finally(() => {
        inFlight = null;
      });

    await inFlight;
  };
}

module.exports = {
  cacheSuccessfulCheck,
  evaluateReadiness,
};
