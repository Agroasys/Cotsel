/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  AdminActor,
  AdminAuthorityChangeKind,
  AdminAuthorityChangeRecord,
  OperatorSignerActionClass,
  OperatorSignerRegisterRecord,
  UserProfile,
  UserRole,
} from '../types';
import { ProfileStore } from './profileStore';
import { OperatorSignerStore } from './operatorSignerStore';
import { AdminAuthorityStore } from './adminAuthorityStore';
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

interface ProposeSignerInput {
  accountId: string;
  walletAddress: string;
  actionClass: OperatorSignerActionClass;
  environment: string;
  custodianName: string;
  approvalTicket: string;
  notes?: string | null;
  actor: AdminActor;
  reason: string;
}

interface ApproveSignerInput {
  bindingId: string;
  evidenceDigest: string;
  actor: AdminActor;
  reason: string;
}

interface ProposeAuthorityChangeInput {
  accountId: string;
  change: AdminAuthorityChangeKind;
  environment: string;
  orgId?: string | null;
  /** Grant only: ISO-8601 instant at which the grant stops conferring authority. */
  expiresAt?: string | null;
  /** Revoke only: the non-admin role the account returns to. */
  resultingRole?: UserRole | null;
  approvalTicket: string;
  actor: AdminActor;
  reason: string;
}

interface DecideAuthorityChangeInput {
  changeId: string;
  actor: AdminActor;
  reason: string;
}

/** Two-person admin authority: the store and the longest grant it may approve. */
export interface AdminAuthorityControl {
  store: AdminAuthorityStore;
  maxGrantTtlSeconds: number;
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
  proposeSigner(input: ProposeSignerInput): Promise<OperatorSignerRegisterRecord>;
  approveSigner(input: ApproveSignerInput): Promise<OperatorSignerRegisterRecord>;
  revokeSigner(input: RevokeSignerInput): Promise<OperatorSignerRegisterRecord | null>;
  listAuthorityChanges(input?: {
    accountId?: string;
    state?: AdminAuthorityChangeRecord['state'];
    limit?: number;
  }): Promise<AdminAuthorityChangeRecord[]>;
  proposeAuthorityChange(input: ProposeAuthorityChangeInput): Promise<AdminAuthorityChangeRecord>;
  approveAuthorityChange(
    input: DecideAuthorityChangeInput & { evidenceDigest: string },
  ): Promise<AdminAuthorityChangeRecord>;
  cancelAuthorityChange(input: DecideAuthorityChangeInput): Promise<AdminAuthorityChangeRecord>;
}

const PRIVILEGE_CHANGE_REQUIRES_TWO_PERSONS =
  'Administrator authority is granted and removed only through a two-person admin authority change';

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

function normalizeEnvironment(value: string): string {
  const environment = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) {
    throw new Error('environment must be a lowercase environment name');
  }
  return environment;
}

export function createAdminService(
  profiles: ProfileStore,
  maxBreakGlassTtlSeconds: number,
  signerStore?: OperatorSignerStore,
  authority?: AdminAuthorityControl,
): AdminService {
  function requireSignerStore(): OperatorSignerStore {
    if (!signerStore) {
      throw new Error('Operator signer register is not configured');
    }
    return signerStore;
  }

  function requireAuthority(): AdminAuthorityControl {
    if (!authority) {
      throw new Error('Admin authority changes are not configured');
    }
    return authority;
  }

  function grantExpiry(value: string | null | undefined, maxTtlSeconds: number): Date {
    const expiresAt = typeof value === 'string' ? new Date(value) : new Date(NaN);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('expiresAt must be an ISO-8601 timestamp for an admin grant');
    }
    const remainingSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    if (remainingSeconds < 3600 || remainingSeconds > maxTtlSeconds) {
      throw new Error(
        `expiresAt must be between 1 hour and ${maxTtlSeconds} seconds from now for an admin grant`,
      );
    }
    return expiresAt;
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
      if (input.role === 'admin') {
        throw new Error(PRIVILEGE_CHANGE_REQUIRES_TWO_PERSONS);
      }
      const previous = await profiles.findByAccountId(input.accountId);
      // Deactivation, not provisioning, is the single-person containment path for
      // an active administrator.
      if (previous?.baseRole === 'admin' && previous.active) {
        throw new Error(PRIVILEGE_CHANGE_REQUIRES_TWO_PERSONS);
      }
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

    async proposeSigner(input) {
      const normalizedEnvironment = input.environment.trim().toLowerCase();
      if (normalizedEnvironment === '*') {
        throw new Error('environment wildcard is not allowed for signer bindings');
      }
      const environment = normalizeRequiredEvidence(normalizedEnvironment, 'environment', 64);
      return requireSignerStore().propose({
        accountId: input.accountId.trim(),
        walletAddress: input.walletAddress.toLowerCase(),
        actionClass: input.actionClass,
        environment,
        custodianName: normalizeRequiredEvidence(input.custodianName, 'custodianName'),
        approvalTicket: normalizeRequiredEvidence(input.approvalTicket, 'approvalTicket'),
        notes: input.notes?.trim() || null,
        actor: input.actor,
        reason: normalizeReason(input.reason),
      });
    },

    async approveSigner(input) {
      const evidenceDigest = input.evidenceDigest.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) {
        throw new Error('evidenceDigest must be a lowercase SHA-256 digest');
      }
      return requireSignerStore().approve({
        bindingId: normalizeRequiredEvidence(input.bindingId, 'bindingId'),
        evidenceDigest,
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

    async listAuthorityChanges(input = {}) {
      return requireAuthority().store.list(input);
    },

    async proposeAuthorityChange(input) {
      const control = requireAuthority();
      const environment = normalizeEnvironment(input.environment);
      const common = {
        accountId: normalizeRequiredEvidence(input.accountId, 'accountId'),
        environment,
        approvalTicket: normalizeRequiredEvidence(input.approvalTicket, 'approvalTicket'),
        reason: normalizeReason(input.reason),
        actor: input.actor,
      };
      let record: AdminAuthorityChangeRecord;
      if (input.change === 'grant') {
        if (input.resultingRole && input.resultingRole !== 'admin') {
          throw new Error('An admin grant cannot set resultingRole');
        }
        record = await control.store.propose({
          ...common,
          change: 'grant',
          orgId: input.orgId?.trim() || null,
          grantExpiresAt: grantExpiry(input.expiresAt, control.maxGrantTtlSeconds),
          resultingRole: 'admin',
        });
      } else if (input.change === 'revoke') {
        if (input.resultingRole !== 'buyer' && input.resultingRole !== 'supplier') {
          throw new Error('An admin revocation requires resultingRole buyer or supplier');
        }
        if (input.expiresAt || input.orgId) {
          throw new Error('An admin revocation cannot set expiresAt or orgId');
        }
        record = await control.store.propose({
          ...common,
          change: 'revoke',
          orgId: null,
          grantExpiresAt: null,
          resultingRole: input.resultingRole,
        });
      } else {
        throw new Error('change must be grant or revoke');
      }
      Logger.warn('Admin authority change proposed', {
        eventType: 'auth.admin_authority_change_proposed',
        changeId: record.changeId,
        change: record.change,
        environment: record.environment,
      });
      return record;
    },

    async approveAuthorityChange(input) {
      const evidenceDigest = input.evidenceDigest.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) {
        throw new Error('evidenceDigest must be a lowercase SHA-256 digest');
      }
      const record = await requireAuthority().store.approve({
        changeId: normalizeRequiredEvidence(input.changeId, 'changeId'),
        evidenceDigest,
        actor: input.actor,
        reason: normalizeReason(input.reason),
      });
      if (record.change === 'grant') {
        incrementAdminDurableProvisioned();
      } else {
        incrementAdminDurableRevoked();
      }
      Logger.warn('Admin authority change applied', {
        eventType:
          record.change === 'grant'
            ? 'auth.durable_admin_provisioned'
            : 'auth.durable_admin_revoked',
        changeId: record.changeId,
        environment: record.environment,
      });
      return record;
    },

    async cancelAuthorityChange(input) {
      const record = await requireAuthority().store.cancel({
        changeId: normalizeRequiredEvidence(input.changeId, 'changeId'),
        actor: input.actor,
        reason: normalizeReason(input.reason),
      });
      Logger.warn('Admin authority change cancelled', {
        eventType: 'auth.admin_authority_change_cancelled',
        changeId: record.changeId,
      });
      return record;
    },
  };
}
