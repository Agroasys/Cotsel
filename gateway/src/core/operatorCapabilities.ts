/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AuthServiceRole } from './authSessionClient';
import type { GatewayConfig } from '../config/env';
import { type GatewayPrincipal, type GatewayRole, matchesAllowlist } from '../middleware/auth';

export interface OperatorRouteCapabilities {
  overviewRead: boolean;
  operationsRead: boolean;
  tradesRead: boolean;
  governanceRead: boolean;
  complianceRead: boolean;
}

export interface OperatorActionCapabilities {
  governanceWrite: boolean;
  complianceWrite: boolean;
}

export interface OperatorWriteAccess {
  mutationsConfigured: boolean;
  allowlisted: boolean;
  effective: boolean;
}

export interface OperatorCapabilitySubject {
  accountId: string;
  userId: string;
  walletAddress: string | null;
  authRole: AuthServiceRole;
  gatewayRoles: GatewayRole[];
}

export interface OperatorCapabilitySnapshot {
  subject: OperatorCapabilitySubject;
  routes: OperatorRouteCapabilities;
  actions: OperatorActionCapabilities;
  writeAccess: OperatorWriteAccess;
}

export function buildOperatorCapabilitySnapshot(
  principal: GatewayPrincipal,
  config: GatewayConfig,
): OperatorCapabilitySnapshot {
  const canReadOperatorRoutes = principal.gatewayRoles.includes('operator:read');
  const allowlisted = matchesAllowlist(principal.session, config.writeAllowlist);
  const canWriteOperatorActions = principal.gatewayRoles.includes('operator:write')
    && config.enableMutations
    && allowlisted;

  return {
    subject: {
      accountId: principal.session.accountId ?? principal.session.userId,
      userId: principal.session.userId,
      walletAddress: principal.session.walletAddress,
      authRole: principal.session.role,
      gatewayRoles: principal.gatewayRoles,
    },
    routes: {
      overviewRead: canReadOperatorRoutes,
      operationsRead: canReadOperatorRoutes,
      tradesRead: canReadOperatorRoutes,
      governanceRead: canReadOperatorRoutes,
      complianceRead: canReadOperatorRoutes,
    },
    actions: {
      governanceWrite: canWriteOperatorActions,
      complianceWrite: canWriteOperatorActions,
    },
    writeAccess: {
      mutationsConfigured: config.enableMutations,
      allowlisted,
      effective: canWriteOperatorActions,
    },
  };
}
