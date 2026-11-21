/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AgroasysSDKError } from '../types/errors';

/**
 * Custody modes, ordered from least to most custody. A deployment declares one
 * mode; every settlement records the mode it was created under.
 *
 * - `non_custodial`: participants hold their own keys and funds; Cotsel only
 *   coordinates (Agroasys: embedded wallets, KMS oracle signer, direct USDC).
 * - `composed_partner`: a regulated partner, composed into the flow, holds funds
 *   or keys for part of it under the partner's own licence.
 * - `licensed_custodial`: a licensed custodian holds funds or keys end to end.
 *
 * Cotsel itself is never the custodian in any mode.
 */
export const CUSTODY_MODES = ['non_custodial', 'composed_partner', 'licensed_custodial'] as const;

export type CustodyMode = (typeof CUSTODY_MODES)[number];

const CUSTODY_RANK: Record<CustodyMode, number> = {
  non_custodial: 0,
  composed_partner: 1,
  licensed_custodial: 2,
};

export function isCustodyMode(value: unknown): value is CustodyMode {
  return typeof value === 'string' && (CUSTODY_MODES as readonly string[]).includes(value);
}

/**
 * True when `mode` allows something of custody class `custodyClass`. A mode allows
 * its own class and every class with less custody, never one with more.
 */
export function custodyModePermits(mode: CustodyMode, custodyClass: CustodyMode): boolean {
  return CUSTODY_RANK[custodyClass] <= CUSTODY_RANK[mode];
}

export type CustodyFirewallEnforcementPoint = 'router' | 'adapter';

export type CustodyFirewallRejection =
  'custody_mode_invalid' | 'settlement_mode_exceeds_deployment' | 'adapter_class_forbidden';

export interface CustodyFirewallErrorContext extends Record<string, unknown> {
  rejection: CustodyFirewallRejection;
  enforcedAt: CustodyFirewallEnforcementPoint;
  custodyMode: string;
  adapterId?: string;
  adapterCustodyClass?: CustodyMode;
  capability?: string;
  deploymentCustodyMode?: CustodyMode;
}

export class CustodyFirewallError extends AgroasysSDKError {
  declare context: CustodyFirewallErrorContext;

  constructor(message: string, context: CustodyFirewallErrorContext) {
    super(message, 'CUSTODY_FIREWALL_REJECTED', context);
    this.name = 'CustodyFirewallError';
  }

  get rejection(): CustodyFirewallRejection {
    return this.context.rejection;
  }
}

export interface CustodySubject {
  id: string;
  capability: string;
  custodyClass: CustodyMode;
}

/**
 * Throws `CustodyFirewallError` unless `custodyMode` is a declared mode that allows
 * the adapter's custody class. Called by the router and again by every guarded
 * adapter entry point.
 */
export function assertCustodyPermits(
  custodyMode: unknown,
  adapter: CustodySubject,
  enforcedAt: CustodyFirewallEnforcementPoint,
): asserts custodyMode is CustodyMode {
  if (!isCustodyMode(custodyMode)) {
    throw new CustodyFirewallError('Custody mode is not a declared mode', {
      rejection: 'custody_mode_invalid',
      enforcedAt,
      custodyMode: String(custodyMode),
      adapterId: adapter.id,
      capability: adapter.capability,
    });
  }
  if (!custodyModePermits(custodyMode, adapter.custodyClass)) {
    throw new CustodyFirewallError(
      `Custody mode ${custodyMode} forbids ${adapter.custodyClass} adapter ${adapter.id}`,
      {
        rejection: 'adapter_class_forbidden',
        enforcedAt,
        custodyMode,
        adapterId: adapter.id,
        adapterCustodyClass: adapter.custodyClass,
        capability: adapter.capability,
      },
    );
  }
}

/**
 * Throws unless a settlement's recorded mode is one the deployment allows. A
 * settlement cannot claim more custody than the deployment it runs in.
 */
export function assertSettlementModeWithinDeployment(
  settlementMode: unknown,
  deploymentMode: CustodyMode,
): asserts settlementMode is CustodyMode {
  if (!isCustodyMode(settlementMode)) {
    throw new CustodyFirewallError('Settlement custody mode is not a declared mode', {
      rejection: 'custody_mode_invalid',
      enforcedAt: 'router',
      custodyMode: String(settlementMode),
      deploymentCustodyMode: deploymentMode,
    });
  }
  if (!custodyModePermits(deploymentMode, settlementMode)) {
    throw new CustodyFirewallError(
      `Settlement custody mode ${settlementMode} exceeds deployment mode ${deploymentMode}`,
      {
        rejection: 'settlement_mode_exceeds_deployment',
        enforcedAt: 'router',
        custodyMode: settlementMode,
        deploymentCustodyMode: deploymentMode,
      },
    );
  }
}
