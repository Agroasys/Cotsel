/**
 * SPDX-License-Identifier: Apache-2.0
 */

const counters: Record<string, number> = {
  sessions_issued: 0,
  sessions_refreshed: 0,
  sessions_revoked: 0,
  login_errors: 0,
  admin_durable_provisioned: 0,
  admin_durable_revoked: 0,
  admin_break_glass_granted: 0,
  admin_break_glass_revoked: 0,
  admin_break_glass_expired: 0,
  service_auth_denied: 0,
  service_auth_nonce_replay: 0,
  rate_limit_fail_closed: 0,
  rate_limit_fail_open: 0,
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

export function incrementAdminDurableProvisioned(): void {
  increment('admin_durable_provisioned');
}

export function incrementAdminDurableRevoked(): void {
  increment('admin_durable_revoked');
}

export function incrementAdminBreakGlassGranted(): void {
  increment('admin_break_glass_granted');
}

export function incrementAdminBreakGlassRevoked(): void {
  increment('admin_break_glass_revoked');
}

export function incrementAdminBreakGlassExpired(): void {
  increment('admin_break_glass_expired');
}

export function incrementServiceAuthDenied(): void {
  increment('service_auth_denied');
}

export function incrementServiceAuthNonceReplay(): void {
  increment('service_auth_nonce_replay');
}

export function incrementRateLimitFailClosed(): void {
  increment('rate_limit_fail_closed');
}

export function incrementRateLimitFailOpen(): void {
  increment('rate_limit_fail_open');
}

export function getCounters(): Record<string, number> {
  return { ...counters };
}
