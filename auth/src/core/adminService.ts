/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  AdminActor,
  OperatorSignerActionClass,
  OperatorSignerRegisterRecord,
  UserProfile,
  UserRole,
} from '../types';
import { ProfileStore } from './profileStore';
import { OperatorSignerStore } from './operatorSignerStore';
import type { AdminAuditEventRecord, OperatorProfileAuthoritySnapshot } from '../database/queries';
import {
  incrementAdminBreakGlassGranted,
  incrementAdminBreakGlassRevoked,
  incrementAdminDurableProvisioned,
  incrementAdminDurableRevoked,
} from '../metrics/counters';
import { Logger } from '../utils/logger';

interface ProvisionProfileInput {
  accountId: string;
  role: UserRole;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  actor: AdminActor;
  reason: string;
}

interface GrantBreakGlassInput {
  accountId: string;
  orgId?: string | null;
  email?: string | null;
  walletAddress?: string | null;
  actor: AdminActor;
  reason: string;
  ttlSeconds: number;
  baseRole?: Exclude<UserRole, 'admin'>;
}

interface AccountActionInput {
  accountId: string;
  actor: AdminActor;
  reason: string;
}

interface ProvisionSignerInput {
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvingAuthority: string;
  approvedAt: string;
  approvalTicket: string;
  notes?: string | null;
  actor: AdminActor;
  reason: string;
}

interface RevokeSignerInput {
  bindingId: string;
  actor: AdminActor;
  reason: string;
}

export interface AdminService {
  listAuthorityProfiles(input?: { limit?: number }): Promise<OperatorProfileAuthoritySnapshot[]>;
  listAuditEvents(input?: { accountId?: string; limit?: number }): Promise<AdminAuditEventRecord[]>;
  provisionProfile(input: ProvisionProfileInput): Promise<UserProfile>;
  grantBreakGlass(input: GrantBreakGlassInput): Promise<UserProfile>;
  revokeBreakGlass(input: AccountActionInput): Promise<UserProfile | null>;
  reviewBreakGlass(input: AccountActionInput): Promise<UserProfile>;
  deactivateProfile(input: AccountActionInput): Promise<UserProfile>;
  listSignerBindings(input?: {
    accountId?: string;
    active?: boolean;
    limit?: number;
  }): Promise<OperatorSignerRegisterRecord[]>;
  provisionSigner(input: ProvisionSignerInput): Promise<OperatorSignerRegisterRecord>;
  revokeSigner(input: RevokeSignerInput): Promise<OperatorSignerRegisterRecord | null>;
}

function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 8) {
    throw new Error('Reason must be at least 8 characters');
  }
  if (trimmed.length > 500) {
    throw new Error('Reason must be 500 characters or fewer');
  }
  return trimmed;
}

function normalizeRequiredEvidence(value: string, field: string, maxLength = 200): string {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > maxLength) {
    throw new Error(`${field} must be between 2 and ${maxLength} characters`);
  }
  return normalized;
}

export function createAdminService(
  profiles: ProfileStore,
  maxBreakGlassTtlSeconds: number,
  signerStore?: OperatorSignerStore,
): AdminService {
  function requireSignerStore(): OperatorSignerStore {
    if (!signerStore) {
      throw new Error('Operator signer register is not configured');
    }
    return signerStore;
  }

  return {
    async listAuthorityProfiles(input = {}) {
      return profiles.listAuthorityProfiles(input);
    },

    async listAuditEvents(input = {}) {
      return profiles.listAuditEvents(input);
    },

    async provisionProfile(input) {
      const reason = normalizeReason(input.reason);
      const previous = await profiles.findByAccountId(input.accountId);
      const profile = await profiles.provision({ ...input, reason });
      const previousWasDurableAdmin = previous?.baseRole === 'admin';
      const nowDurableAdmin = profile.baseRole === 'admin';

      if (!previousWasDurableAdmin && nowDurableAdmin) {
        incrementAdminDurableProvisioned();
      }
      if (previousWasDurableAdmin && !nowDurableAdmin) {
        incrementAdminDurableRevoked();
      }
      let eventType = 'auth.profile_role_updated';
      if (!previousWasDurableAdmin && nowDurableAdmin) {
        eventType = 'auth.durable_admin_provisioned';
      } else if (previousWasDurableAdmin && nowDurableAdmin) {
        eventType = 'auth.admin_profile_updated';
      } else if (previousWasDurableAdmin && !nowDurableAdmin) {
        eventType = 'auth.durable_admin_revoked';
      }
      Logger.info('Admin profile control updated', {
        eventType,
        actorId: input.actor.id,
        accountId: input.accountId,
        previousRole: previous?.baseRole ?? null,
        newRole: profile.baseRole,
      });
      return profile;
    },

    async grantBreakGlass(input) {
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
        throw new Error('ttlSeconds must be a positive integer');
      }
      if (input.ttlSeconds > maxBreakGlassTtlSeconds) {
        throw new Error(`ttlSeconds must be <= ${maxBreakGlassTtlSeconds}`);
      }

      const profile = await profiles.grantBreakGlass({
        ...input,
        baseRole: input.baseRole ?? 'buyer',
        reason: normalizeReason(input.reason),
      });
      incrementAdminBreakGlassGranted();
      Logger.warn('Break-glass admin granted', {
        eventType: 'auth.break_glass_granted',
        actorId: input.actor.id,
        accountId: input.accountId,
        expiresAt: profile.breakGlassExpiresAt?.toISOString() ?? null,
      });
      return profile;
    },

    async revokeBreakGlass(input) {
      const profile = await profiles.revokeBreakGlass(
        input.accountId,
        input.actor,
        normalizeReason(input.reason),
      );
      if (profile) {
        incrementAdminBreakGlassRevoked();
        Logger.warn('Break-glass admin revoked', {
          eventType: 'auth.break_glass_revoked',
          actorId: input.actor.id,
          accountId: input.accountId,
        });
      }
      return profile;
    },

    async reviewBreakGlass(input) {
      return profiles.reviewBreakGlass(input.accountId, input.actor, normalizeReason(input.reason));
    },

    async deactivateProfile(input) {
      const previous = await profiles.findByAccountId(input.accountId);
      const profile = await profiles.deactivateWithAudit(
        input.accountId,
        input.actor,
        normalizeReason(input.reason),
      );
      const revokedDurableAdmin = previous?.baseRole === 'admin' && previous.active;
      if (revokedDurableAdmin) {
        incrementAdminDurableRevoked();
      }
      Logger.warn('Admin profile deactivated', {
        eventType: revokedDurableAdmin ? 'auth.durable_admin_revoked' : 'auth.profile_deactivated',
        actorId: input.actor.id,
        accountId: input.accountId,
      });
      return profile;
    },

    async listSignerBindings(input = {}) {
      return requireSignerStore().list(input);
    },

    async provisionSigner(input) {
      const normalizedEnvironment = input.environment.trim().toLowerCase();
      if (normalizedEnvironment === '*') {
        throw new Error('environment wildcard is not allowed for signer bindings');
      }
      const environment = normalizeRequiredEvidence(normalizedEnvironment, 'environment', 64);
      const approvedAt = new Date(input.approvedAt);
      if (Number.isNaN(approvedAt.getTime())) {
        throw new Error('approvedAt must be an ISO date-time');
      }
      if (approvedAt.getTime() > Date.now()) {
        throw new Error('approvedAt cannot be in the future');
      }

      return requireSignerStore().provision({
        accountId: input.accountId.trim(),
        walletAddress: input.walletAddress.toLowerCase(),
        actionClass: input.actionClass,
        environment,
        custodianName: normalizeRequiredEvidence(input.custodianName, 'custodianName'),
        approvingAuthority: normalizeRequiredEvidence(
          input.approvingAuthority,
          'approvingAuthority',
        ),
        approvedAt,
        approvalTicket: normalizeRequiredEvidence(input.approvalTicket, 'approvalTicket'),
        notes: input.notes?.trim() || null,
        actor: input.actor,
        reason: normalizeReason(input.reason),
      });
    },

    async revokeSigner(input) {
      return requireSignerStore().revoke({
        bindingId: normalizeRequiredEvidence(input.bindingId, 'bindingId'),
        actor: input.actor,
        reason: normalizeReason(input.reason),
      });
    },
  };
}
