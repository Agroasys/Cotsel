const {
  NotificationDeliveryError,
  NotificationDispatcher,
  sanitizeDeliveryError,
} = require('../dist/index.js');

function createEvent(overrides = {}) {
  return {
    source: 'oracle',
    type: 'ORACLE_TRIGGER_TERMINAL_FAILURE',
    severity: 'critical',
    dedupKey: 'oracle:critical:trade-1',
    message: 'terminal failure',
    correlation: { tradeId: '1' },
    ...overrides,
  };
}

/**
 * An in-memory stand-in for NotificationOutbox with the same contract, so the
 * dispatcher's decisions can be tested without Postgres. The SQL itself is
 * proven against a real database in the reconciliation Postgres suite.
 */
class FakeOutbox {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }

  async enqueue(event) {
    const pending = this.rows.find(
      (row) => row.state === 'PENDING' && row.dedupKey === event.dedupKey,
    );
    if (pending) {
      pending.occurrences += 1;
      return 'merged';
    }
    this.rows.push({
      id: String(this.nextId++),
      event,
      dedupKey: event.dedupKey,
      state: 'PENDING',
      attempts: 0,
      occurrences: 1,
      lastError: null,
      leaseOwner: null,
      escalated: null,
      createdAt: new Date(),
      overdue: false,
    });
    return 'queued';
  }

  async claimDue({ owner, limit, maxAttempts, excludeIds = [] }) {
    this.claimCalls = (this.claimCalls ?? 0) + 1;
    const due = this.rows
      .filter(
        (row) =>
          row.state === 'PENDING' &&
          !row.leaseOwner &&
          row.attempts < maxAttempts &&
          !excludeIds.includes(row.id),
      )
      .slice(0, limit);
    for (const row of due) {
      row.leaseOwner = owner;
      row.attempts += 1;
    }
    return due.map((row) => ({ id: row.id, event: row.event, attempts: row.attempts }));
  }

  async markDelivered(id, owner) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.leaseOwner !== owner) return false;
    row.state = 'DELIVERED';
    row.leaseOwner = null;
    return true;
  }

  async markFailed({ id, owner, error, retryDelayMs, maxAttempts }) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.leaseOwner !== owner) return null;
    row.lastError = sanitizeDeliveryError(error);
    row.lastRetryDelayMs = retryDelayMs;
    row.leaseOwner = null;
    row.state = row.attempts >= maxAttempts ? 'DEAD_LETTER' : 'PENDING';
    return row.state;
  }

  async deadLetterExhausted(maxAttempts) {
    let count = 0;
    for (const row of this.rows) {
      if (row.state === 'PENDING' && !row.leaseOwner && row.attempts >= maxAttempts) {
        row.state = 'DEAD_LETTER';
        count += 1;
      }
    }
    return count;
  }

  needsEscalation(row) {
    return (
      row.event.severity === 'critical' &&
      !row.escalated &&
      (row.state === 'DEAD_LETTER' || (row.state === 'PENDING' && row.overdue))
    );
  }

  async claimEscalations({ limit, excludeIds = [] }) {
    return this.rows
      .filter(
        (row) =>
          this.needsEscalation(row) && !row.escalationBlocked && !excludeIds.includes(row.id),
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        event: row.event,
        reason: row.state === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'DELIVERY_OVERDUE',
        attempts: row.attempts,
        occurrences: row.occurrences,
        lastError: row.lastError,
        createdAt: row.createdAt,
      }));
  }

  async markEscalated(id, reason) {
    this.rows.find((row) => row.id === id).escalated = reason;
  }

  async markEscalationFailed(id, error) {
    const row = this.rows.find((candidate) => candidate.id === id);
    row.escalationError = error;
    row.escalationBlocked = true;
  }

  async stats() {
    return {
      pending: this.rows.filter((row) => row.state === 'PENDING').length,
      oldestPendingAgeMs: null,
      deadLetters: this.rows.filter((row) => row.state === 'DEAD_LETTER').length,
      awaitingEscalation: this.rows.filter((row) => this.needsEscalation(row)).length,
    };
  }
}

function recordingTransport({
  failures = 0,
  error = 'Webhook responded 503 Service Unavailable',
} = {}) {
  const transport = {
    calls: [],
    remainingFailures: failures,
    async deliver(event) {
      transport.calls.push(event);
      if (transport.remainingFailures > 0) {
        transport.remainingFailures -= 1;
        throw new NotificationDeliveryError(error);
      }
    },
  };
  return transport;
}

function silentLogger() {
  const entries = [];
  const push = (level) => (message, meta) => entries.push({ level, message, meta });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function dispatcherFor(outbox, overrides = {}) {
  return new NotificationDispatcher({
    outbox,
    transport: recordingTransport(),
    owner: 'dispatcher-a',
    maxAttempts: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 8000,
    logger: silentLogger(),
    ...overrides,
  });
}

module.exports = { FakeOutbox, createEvent, dispatcherFor, recordingTransport, silentLogger };
