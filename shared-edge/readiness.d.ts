export interface ReadinessCheck {
  name: string;
  /** Required checks decide readiness; optional checks are reported only. Defaults to true. */
  required?: boolean;
  /** Not part of this profile: reported as `disabled` and never run. Implies optional. */
  disabled?: boolean;
  timeoutMs?: number;
  check: () => Promise<unknown>;
}

export interface ReadinessDependencyResult {
  name: string;
  required: boolean;
  status: 'ok' | 'unavailable' | 'disabled';
  reason?: 'failed' | 'timeout';
  durationMs: number;
}

export interface ReadinessResult {
  ready: boolean;
  dependencies: ReadinessDependencyResult[];
}

export function evaluateReadiness(
  checks: ReadinessCheck[],
  options?: { defaultTimeoutMs?: number; now?: () => number },
): Promise<ReadinessResult>;

export function cacheSuccessfulCheck(
  check: () => Promise<unknown>,
  ttlMs: number,
  now?: () => number,
): () => Promise<void>;
