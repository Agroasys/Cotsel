/**
 * SPDX-License-Identifier: Apache-2.0
 */
export { normalizeSessionRow } from './queries/sessionNormalization';
export {
  deactivateProfile,
  findProfileByAccountId,
  findProfileById,
  findProfileByWallet,
  upsertProfile,
  upsertTrustedProfile,
} from './queries/profiles';
export {
  deactivateProfileWithAudit,
  listAdminAuditEvents,
  listOperatorAuthorityProfiles,
  provisionProfileWithAudit,
} from './queries/adminAudit';
export type { AdminAuditEventRecord, OperatorProfileAuthoritySnapshot } from './queries/adminAudit';
export {
  grantBreakGlassAdmin,
  reviewBreakGlassAdmin,
  revokeBreakGlassAdmin,
} from './queries/breakGlass';
export {
  findSessionById,
  insertSession,
  pruneExpiredSessions,
  revokeSession,
} from './queries/sessions';
