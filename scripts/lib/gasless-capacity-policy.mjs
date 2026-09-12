export function envNumber(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

export function envBigInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(raw);
}

export function envBool(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function envPositiveInteger(name, fallback) {
  const value = envNumber(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseUrlList(raw) {
  return (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isProtectedSignerUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname.endsWith('.internal'));
  } catch {
    return false;
  }
}

export function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

export const FAILURE_MODE_EVIDENCE_REQUIREMENTS = {
  relayerOutageOrDisabled: {
    scenario: 'relayer_outage_or_disabled',
    requiredChecks: ['readinessCaptured', 'broadcastPausedOrDisabled', 'noUserEthRequired'],
  },
  fallbackUx: {
    scenario: 'fallback_ux',
    requiredChecks: ['fallbackPresented', 'operatorRecoveryPathCaptured', 'noUserEthRequired'],
  },
  operatorFailureRehearsal: {
    scenario: 'operator_failure_rehearsal',
    requiredChecks: ['readinessCaptured'],
    anyChecks: [
      'stuckQueueAlertVisible',
      'repeatedFailureAlertVisible',
      'droppedExecutionCaptured',
    ],
  },
};

export function evidencePacketPasses(packet, requirement) {
  if (!packet || typeof packet !== 'object') return false;
  const checks = packet.checks && typeof packet.checks === 'object' ? packet.checks : {};
  const requiredChecksPass = requirement.requiredChecks.every((key) => checks[key] === true);
  const anyChecksPass = requirement.anyChecks
    ? requirement.anyChecks.some((key) => checks[key] === true)
    : true;
  return (
    packet.status === 'passed' &&
    packet.scenario === requirement.scenario &&
    typeof packet.evidenceRef === 'string' &&
    packet.evidenceRef.trim().length > 0 &&
    typeof packet.observedAt === 'string' &&
    Number.isFinite(Date.parse(packet.observedAt)) &&
    requiredChecksPass &&
    anyChecksPass
  );
}
