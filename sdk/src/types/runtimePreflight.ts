/**
 * SPDX-License-Identifier: Apache-2.0
 */

export type RuntimePreflightFailureCode =
  | 'RPC_UNAVAILABLE'
  | 'WRONG_CHAIN'
  | 'INVALID_CONTRACT_ADDRESS'
  | 'CONTRACT_CODE_MISSING'
  | 'CONTRACT_READ_FAILED'
  | 'WRONG_USDC'
  | 'ROLE_EXPECTATIONS_MISSING'
  | 'ROLE_STATE_MISMATCH';

export interface RuntimePreflightObservation {
  chainId: number | null;
  escrowAddress: string;
  codePresent: boolean;
  usdcAddress: string | null;
  oracleAddress: string | null;
  treasuryAddress: string | null;
  treasuryPayoutAddress: string | null;
  oracleActive: boolean | null;
  requiredApprovals: number | null;
}

export interface RuntimePreflightResult {
  ok: boolean;
  failureCodes: RuntimePreflightFailureCode[];
  observation: RuntimePreflightObservation;
}
