# Auth Break-Glass Runbook

This runbook governs temporary Cotsel admin elevation for emergencies.

## Scope

Break-glass is for time-bound emergency access when normal durable admin
provisioning is too slow for an active incident. It must not be used for routine
operator onboarding, convenience access, planned release work, or bypassing the
Agroasys platform admin model.

## Authority

- Initiator: incident commander or security owner.
- Approver: a second production operator or security owner, unless the incident
  commander documents why single-person emergency action was required.
- Executor: service principal whose API key ID is listed in
  `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`.
- Reviewer: security owner who was not the executor.

## Preconditions

Before granting break-glass:

1. Open or identify an incident ticket.
2. Confirm the target `accountId`.
3. Confirm the target durable base role is not `admin` by reading
   `user_profiles.role` for the target account through the approved production
   database access path.
4. Set a TTL no longer than `AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS`.
5. Record the reason with the incident ID and planned expiry.

Minimum state check:

```sql
SELECT account_id, role, active, break_glass_role, break_glass_expires_at
FROM user_profiles
WHERE account_id = '<target account id>';
```

## Grant Temporary Admin

Endpoint:

```text
POST /api/auth/v1/admin/break-glass/grant
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "baseRole": "buyer",
  "email": "operator@example.com",
  "walletAddress": "0x0000000000000000000000000000000000000000",
  "orgId": "agroasys-ops",
  "ttlSeconds": 1800,
  "reason": "INC-3333 temporary admin needed to freeze affected governance workflow"
}
```

The auth service stores durable `role` separately from temporary
`break_glass_role`. During the TTL, the effective role is `admin`. After expiry
or revocation, the effective role returns to the durable base role.

Granting break-glass revokes active sessions for the target profile. The
operator must obtain a fresh Cotsel session after the grant.

Break-glass does not automatically provision privileged signer authority.
Signer-required gateway actions still require an approved signer wallet binding
for the relevant action class and environment unless a separate policy
explicitly grants that authority.

## Expiry

Break-glass expires at `break_glass_expires_at`. Expired elevation is not
effective for session resolution. If an old session was issued while
break-glass was active, auth resolution revokes it when the effective authority
no longer matches the issued authority.

## Manual Revocation

Revoke as soon as the emergency action is complete.

Endpoint:

```text
POST /api/auth/v1/admin/break-glass/revoke
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "reason": "INC-3333 emergency action complete; temporary admin access revoked"
}
```

Revocation clears temporary elevation and revokes active sessions for the
target profile.

## Post-Incident Review

Endpoint:

```text
POST /api/auth/v1/admin/break-glass/review
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "reason": "INC-3333 reviewed by security owner; actions matched incident scope"
}
```

The reviewer must confirm:

- the incident ticket exists
- the TTL was appropriate
- access was revoked or expired
- no durable admin role was created accidentally
- no signer-required privileged action bypassed the approved signer-binding policy
- privileged actions during the window match the incident scope
- the audit trail exists in `auth_admin_audit_events`

## Required Alerts

Operators should alert on:

- `auth.break_glass_granted`
- `auth.break_glass_revoked`
- `auth.break_glass_expired`
- `auth.nonce_replay_attempted`
- `auth.service_auth_denied`
- break-glass grants that have not been reviewed within one business day

## Evidence Retention

Retain:

- incident ID
- initiator, approver, executor, and reviewer
- signed request metadata without secrets
- API key ID used
- grant response
- revoke or expiry evidence
- review response
- related Cotsel gateway/admin action audit entries
- `auth_admin_audit_events` rows for grant, revoke or expiry, and review

Break-glass evidence must be attached to the incident closeout.
