/**
 * SPDX-License-Identifier: Apache-2.0
 */

const counters: Record<string, number> = {
  sessions_issued: 0,
  sessions_refreshed: 0,
  sessions_revoked: 0,
  login_errors: 0,
};

function increment(name: string): void {
  counters[name] = (counters[name] ?? 0) + 1;
}

export function incrementSessionIssued(): void {
  increment('sessions_issued');
}

export function incrementSessionRefreshed(): void {
  increment('sessions_refreshed');
}

export function incrementSessionRevoked(): void {
  increment('sessions_revoked');
}

export function incrementLoginError(): void {
  increment('login_errors');
}

export function getCounters(): Record<string, number> {
  return { ...counters };
}
