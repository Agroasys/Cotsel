/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import {
  OperatorCapability,
  OperatorSignerActionClass,
  OperatorSignerAuthorization,
} from '../types';
import {
  listOperatorCapabilitiesByAccountId,
  provisionOperatorSignerBinding,
  replaceOperatorCapabilitiesWithAudit,
  revokeOperatorSignerBinding,
} from '../database/queries';
import { AdminActor } from '../types';

export interface OperatorAuthorityStore {
  listCapabilities(accountId: string): Promise<OperatorCapability[]>;
  replaceCapabilities(input: {
    accountId: string;
    capabilities: readonly OperatorCapability[];
    actor: AdminActor;
    reason: string;
    ticketRef?: string | null;
  }): Promise<OperatorCapability[]>;
  provisionSigner(input: {
    accountId: string;
    walletAddress: string;
    actionClass: OperatorSignerActionClass;
    environment: string;
    actor: AdminActor;
    reason: string;
    ticketRef?: string | null;
    notes?: string | null;
  }): Promise<OperatorSignerAuthorization>;
  revokeSigner(input: {
    accountId: string;
    walletAddress: string;
    actionClass: OperatorSignerActionClass;
    environment: string;
    actor: AdminActor;
    reason: string;
  }): Promise<OperatorSignerAuthorization | null>;
}

export function createPostgresOperatorAuthorityStore(pool: Pool): OperatorAuthorityStore {
  return {
    listCapabilities(accountId) {
      return listOperatorCapabilitiesByAccountId(pool, accountId);
    },
    replaceCapabilities(input) {
      return replaceOperatorCapabilitiesWithAudit(pool, input);
    },
    provisionSigner(input) {
      return provisionOperatorSignerBinding(pool, {
        ...input,
        walletAddress: input.walletAddress.toLowerCase(),
      });
    },
    revokeSigner(input) {
      return revokeOperatorSignerBinding(pool, {
        ...input,
        walletAddress: input.walletAddress.toLowerCase(),
      });
    },
  };
}
