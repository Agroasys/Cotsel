"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveGatewayActorKey = resolveGatewayActorKey;
exports.requireWalletBoundSession = requireWalletBoundSession;
exports.matchesAllowlist = matchesAllowlist;
exports.createAuthenticationMiddleware = createAuthenticationMiddleware;
exports.requireGatewayRole = requireGatewayRole;
exports.requireMutationWriteAccess = requireMutationWriteAccess;
/**
 * SPDX-License-Identifier: Apache-2.0
 */
const crypto_1 = require("crypto");
const errors_1 = require("../errors");
function resolveGatewayActorKey(session) {
    const normalizedWallet = session.walletAddress?.trim().toLowerCase();
    if (normalizedWallet) {
        return `wallet:${normalizedWallet}`;
    }
    const normalizedAccountId = session.accountId?.trim();
    if (normalizedAccountId) {
        return `account:${normalizedAccountId}`;
    }
    return `user:${session.userId}`;
}
function requireWalletBoundSession(principal, actionDescription) {
    const walletAddress = principal.session.walletAddress?.trim().toLowerCase();
    if (!walletAddress) {
        throw new errors_1.GatewayError(403, 'FORBIDDEN', `${actionDescription} still requires a linked wallet in the current gateway mutation contract`, {
            reason: 'wallet_required_for_legacy_mutation',
        });
    }
    return walletAddress;
}
function getBearerToken(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return null;
    }
    const token = header.slice(7).trim();
    return token || null;
}
function mapGatewayRoles(session) {
    if (session.role === 'admin') {
        return ['operator:read', 'operator:write'];
    }
    return [];
}
function matchesAllowlist(session, allowlist) {
    if (allowlist.length === 0) {
        return false;
    }
    const candidates = [session.accountId, session.userId, session.walletAddress, session.email].filter(Boolean);
    const normalizedAllowlist = new Set(allowlist.map((entry) => entry.toLowerCase()));
    return candidates.some((entry) => normalizedAllowlist.has(entry.toLowerCase()));
}
function buildSessionReference(token) {
    return `sha256:${(0, crypto_1.createHash)('sha256').update(token, 'utf8').digest('hex')}`;
}
function createAuthenticationMiddleware(client, config) {
    return async (req, _res, next) => {
        const token = getBearerToken(req);
        if (!token) {
            next(new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Missing or malformed Authorization header'));
            return;
        }
        const session = await client.resolveSession(token, req.requestContext?.requestId);
        if (!session) {
            next(new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Session invalid, expired, or revoked'));
            return;
        }
        req.gatewayPrincipal = {
            sessionReference: buildSessionReference(token),
            session,
            gatewayRoles: mapGatewayRoles(session),
            writeEnabled: config.enableMutations && matchesAllowlist(session, config.writeAllowlist),
        };
        next();
    };
}
function requireGatewayRole(role) {
    return (req, _res, next) => {
        if (!req.gatewayPrincipal?.gatewayRoles.includes(role)) {
            next(new errors_1.GatewayError(403, 'FORBIDDEN', `Gateway role '${role}' is required`));
            return;
        }
        next();
    };
}
function requireMutationWriteAccess() {
    return (req, _res, next) => {
        const principal = req.gatewayPrincipal;
        if (!principal) {
            next(new errors_1.GatewayError(401, 'AUTH_REQUIRED', 'Authentication is required'));
            return;
        }
        if (!principal.gatewayRoles.includes('operator:write')) {
            next(new errors_1.GatewayError(403, 'FORBIDDEN', 'Admin session is required for gateway mutations'));
            return;
        }
        if (!principal.writeEnabled) {
            next(new errors_1.GatewayError(403, 'FORBIDDEN', 'Gateway mutations are disabled or caller is not allowlisted', {
                reason: 'disabled_or_not_allowlisted',
            }));
            return;
        }
        next();
    };
}
//# sourceMappingURL=auth.js.map