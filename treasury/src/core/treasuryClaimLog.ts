/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 B-08. Re-derives a `TreasuryClaimed` event from the receipt the chain
 * returns, so a sweep batch is matched against what the escrow actually
 * emitted rather than against the indexer's copy of it.
 *
 * A successful receipt at the right height proves only that *some* transaction
 * landed. A stale or poisoned indexer record can name one that carries no claim
 * log, or a different claim, and still copy the amount and receiver the batch
 * expects. The emitter, the event topic and the decoded arguments are what bind
 * the batch to the sweep that moved the fees.
 */
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { normalizeLogAddress, type SettlementLog } from './chainCanonicality';

const escrowInterface = AgroasysEscrow__factory.createInterface();
const treasuryClaimedEvent = escrowInterface.getEvent('TreasuryClaimed');

export const TREASURY_CLAIMED_TOPIC = treasuryClaimedEvent.topicHash.toLowerCase();

export interface TreasuryClaimFields {
  treasuryIdentity: string;
  payoutReceiver: string;
  amountRaw: string;
  triggeredBy: string | null;
}

export type TreasuryClaimLogVerdict =
  { matched: true; claim: TreasuryClaimFields } | { matched: false; detail: string };

/** Decoded with the escrow ABI; anything that is not this event is null. */
export function decodeTreasuryClaimedLog(log: SettlementLog): TreasuryClaimFields | null {
  const topics = (log.topics ?? []).map((topic) => String(topic).trim().toLowerCase());
  if (topics[0] !== TREASURY_CLAIMED_TOPIC) {
    return null;
  }

  try {
    const decoded = escrowInterface.decodeEventLog(
      treasuryClaimedEvent,
      (log.data ?? '0x').trim(),
      topics,
    );
    return {
      treasuryIdentity: String(decoded.treasuryIdentity).toLowerCase(),
      payoutReceiver: String(decoded.payoutReceiver).toLowerCase(),
      amountRaw: BigInt(decoded.amount).toString(),
      triggeredBy: String(decoded.triggeredBy).toLowerCase(),
    };
  } catch {
    return null;
  }
}

function sameAddress(left: string | null, right: string | null): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

function sameAmount(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

/**
 * The receipt must carry exactly one `TreasuryClaimed` log from the expected
 * escrow, and its decoded arguments must equal the claim being matched. More
 * than one is refused rather than guessed between.
 */
export function verifyTreasuryClaimLog(params: {
  logs: ReadonlyArray<SettlementLog> | null;
  emitter: string;
  expected: TreasuryClaimFields;
}): TreasuryClaimLogVerdict {
  if (!params.logs) {
    return {
      matched: false,
      detail: 'Settlement RPC returned the claim receipt without logs',
    };
  }

  const emitter = normalizeLogAddress(params.emitter);
  const claims = params.logs
    .filter((log) => emitter !== null && normalizeLogAddress(log.address) === emitter)
    .map(decodeTreasuryClaimedLog)
    .filter((claim): claim is TreasuryClaimFields => claim !== null);

  if (claims.length !== 1) {
    return {
      matched: false,
      detail: `Claim receipt carries ${claims.length} TreasuryClaimed logs from ${emitter ?? 'an unknown emitter'}, expected exactly one`,
    };
  }

  const [observed] = claims;
  const mismatched = [
    sameAddress(observed.treasuryIdentity, params.expected.treasuryIdentity)
      ? null
      : 'treasuryIdentity',
    sameAddress(observed.payoutReceiver, params.expected.payoutReceiver) ? null : 'payoutReceiver',
    sameAmount(observed.amountRaw, params.expected.amountRaw) ? null : 'amount',
    // An indexer record may omit the trigger; the chain's value is then kept.
    params.expected.triggeredBy === null ||
    sameAddress(observed.triggeredBy, params.expected.triggeredBy)
      ? null
      : 'triggeredBy',
  ].filter((field): field is string => field !== null);

  if (mismatched.length > 0) {
    return {
      matched: false,
      detail: `TreasuryClaimed log on chain differs from the indexed claim in ${mismatched.join(', ')}`,
    };
  }

  return { matched: true, claim: observed };
}
