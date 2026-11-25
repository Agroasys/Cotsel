# Auth break-glass runbook

This runbook governs temporary Cotsel admin elevation for emergencies.

## Scope

Break-glass is for time-bound emergency access when normal durable admin
provisioning is too slow for an active incident. It must not be used for routine
operator onboarding, convenience access, planned release work, or bypassing the
Agroasys platform admin model.

## Authority

The incident uses these roles:

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
3. Read the target account's `user_profiles.role` through the approved production
   database access path.
4. Confirm the target's durable base role is not `admin`.
5. Set a time to live (TTL) no longer than `AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS`.
6. Record the reason with the incident ID and planned expiry.

Minimum state check:

```sql
SELECT account_id, role, active, break_glass_role, break_glass_expires_at
FROM user_profiles
WHERE account_id = '<target account id>';
```

## Grant temporary admin

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
  "reason": "INC-3333 temporary admin needed to freeze affected governance workflow",
  "operatorAuthentication": {
    "authTime": 1795000000,
    "authMethod": "webauthn",
    "authStrength": "hardware_webauthn"
  }
}
```

### Step-up requirements

Break-glass grants always require recent additional authentication (step-up)
from the granting operator (Cotsel#946). The admin-control caller attests the
operator's step-up in `operatorAuthentication`, as it does for a session
exchange. A hash-based message authentication code (HMAC) covers the request
body.

Cotsel verifies these requirements before it grants access.

- The request must contain `operatorAuthentication`.
- `authStrength` must match a value in
  `AUTH_BREAK_GLASS_STEP_UP_ACCEPTED_STRENGTHS`. The default is `hardware_webauthn`.
- The age of `authTime` must not exceed
  `AUTH_BREAK_GLASS_STEP_UP_MAX_AGE_SECONDS`. The default is `300` seconds.
  The permitted range is 60 to 3600 seconds.

If the step-up is missing, stale, or too weak, Cotsel returns 403
`StepUpRequired` and logs `auth.break_glass_step_up_required`.
If an authentication claim is malformed, Cotsel returns 400.
In both cases, Cotsel refuses the grant. Revocation and review do not require a
step-up.

### Grant audit evidence

For a successful grant, Cotsel writes the verified step-up to
`metadata.stepUp` in the grant's `break_glass_granted` entry in
`auth_admin_audit_events`. The evidence includes `authTime`, `method`,
`strength`, and `ageSeconds` at grant time. It also includes the
`maxAgeSeconds` and `acceptedStrengths` that the step-up satisfied.

Cotsel writes the audit entry in the same database transaction as the grant.
Every grant therefore has an audit entry. The entry contains no credential,
bearer token, or signature.

### Grant request contract

The [break-glass grant fixture](../api/fixtures/cotsel-break-glass-grant.v1.json)
contains the exact request body Agroasys sends. It matches the agroasys-backend
fixture byte for byte (Agroasys/agroasys-backend#823).
The [break-glass step-up tests](../../auth/tests/breakGlassStepUp.test.ts)
verify acceptance while the step-up is fresh and refusal after it becomes stale.

### Deployment order

Deploy the Agroasys admin-control client that sends `operatorAuthentication`
before this Cotsel release. The previous Cotsel grant endpoint ignores unknown
body fields. If Cotsel deploys first, it refuses emergency grants until Agroasys
sends the claims.

### Grant effects

The auth service stores durable `role` separately from temporary
`break_glass_role`. During the TTL, the effective role is `admin`. After expiry
or revocation, the effective role returns to the durable base role.

Granting break-glass revokes active sessions for the target profile. The
operator must obtain a fresh Cotsel session after the grant.

Break-glass does not automatically provision privileged signer authority.
Signer-required gateway actions still require an approved signer wallet binding
for the relevant action class and environment unless a separate policy
explicitly grants that authority.

The gateway enforces break-glass signer policy separately from durable admin
signer policy. While break-glass is active, ordinary signer-required action
classes are restricted even if the session can otherwise reach emergency-safe
operator routes:

- `governance`: blocked under break-glass.
- `treasury_approve`: blocked under break-glass.
- `treasury_execute`: blocked under break-glass.
- `treasury_close`: blocked under break-glass.
- `compliance_sensitive`: blocked under break-glass.
- `emergency_admin`: allowed only when the account has an explicit active signer
  binding for `emergency_admin` in the active gateway signer environment.
  Outside active break-glass authority, `emergency_admin` remains restricted even
  if such a binding exists.

Rejected signer attempts return `SIGNER_POLICY_RESTRICTED` with the action
class, signer environment, and break-glass evidence fields. Successful
privileged audit records include these fields:

- `breakGlassActive`
- `breakGlassReason`
- `breakGlassExpiresAt`
- `breakGlassReviewedAt`
- `breakGlassReviewedBy`
- `breakGlassReviewStatus`

Reviewers can distinguish normal signer use from incident authority. They can also determine whether emergency access still needs post-incident closure.

Gateway session validation treats the break-glass review status as required
evidence. If auth omits `breakGlass.reviewStatus` or emits an unknown value, the
gateway fails closed instead of accepting an ambiguous emergency posture.

## Expiry

Break-glass expires at `break_glass_expires_at`. Expired elevation is not
effective for session resolution. If an old session was issued while
break-glass was active, auth resolution revokes it when the effective authority
no longer matches the issued authority.

## Manual revocation

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

## Post-incident review

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
- any signer-required action attempted during break-glass has either
  `SIGNER_POLICY_RESTRICTED` evidence or an explicit `emergency_admin` signer
  binding and incident approval
- privileged actions during the window match the incident scope
- the audit trail exists in `auth_admin_audit_events`
- the profile/session break-glass context has `reviewStatus: reviewed` after
  review is complete

## Required alerts

Configure alerts for these events and conditions.

- `auth.break_glass_granted`
- `auth.break_glass_step_up_required` (a grant refused because the step-up is
  missing, stale, or too weak)
- `auth.break_glass_revoked`
- `auth.break_glass_expired`
- `auth.nonce_replay_attempted`
- `auth.service_auth_denied`
- break-glass grants that have not been reviewed within one business day

## Evidence retention

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
