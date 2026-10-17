# Auth Admin Provisioning Runbook

This runbook governs durable Cotsel auth role changes performed through the
auth service admin-control plane.

## Scope

Use this procedure only for Cotsel-local auth profile provisioning,
reactivation, durable role changes, and durable admin revocation. Normal
operator dashboard session issuance remains owned by `agroasys-backend` through
the signed `POST /session/exchange/agroasys` route.

Durable administrator authority is granted and removed only through two-person
admin authority changes (below). Profile provisioning manages non-admin profiles
and cannot grant, change, or remove administrator authority; it returns `403`
for `role: "admin"` and for any active administrator.

An account holds administrator authority only while the latest applied authority
change for it in this service's `COTSEL_ENVIRONMENT` is an unexpired grant. Session
exchange and session lookup both enforce this: an `admin` profile without such a
grant is refused at exchange, and its sessions are revoked on next use. Exchange
never creates, promotes, demotes, or re-homes administrator authority; it also
requires the exchange key's policy in `TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON`
to include `admin` and any bound organization to match. Grant each operator
here before their first dashboard session.

### Upgrade: existing administrators

No existing administrator carries an applied grant when migration
`202610140005_admin_authority_changes` is deployed. From that release, every
`admin` profile is refused at exchange and its sessions are revoked on next use
until a grant is proposed and approved. Before deploying, list the accounts that
need a grant through the approved production database access path:

```sql
SELECT account_id, org_id FROM user_profiles WHERE role = 'admin' AND active;
```

Prepare a proposal for each account that should keep administrator authority,
then approve each one with a second human immediately after deployment. Any
listed account that should not stay an administrator is revoked to its correct
role through the same two-person flow.

## Authority

- Initiator: Cotsel production operator, security engineer, or release manager
  with an approved ticket.
- Approver: a second production operator or security owner for durable admin
  grants and durable admin revocations.
- Executor: a signed admin-control credential whose API key ID is listed in
  `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS` and is bound in secret-managed
  configuration to the canonical identity of the human using it.
- Trust root: Cotsel auth service verifies signed service-auth headers and
  stores the durable role state in Postgres.

No browser client, dashboard client, or caller-supplied login role is
authoritative for durable admin access.

The durable admin role grants the operator capability set, but it does not grant
signer authority. Privileged signing additionally requires an explicit, active
signer-register record for the exact account, wallet, action class, and
environment.

## Required Configuration

The auth service must be started with:

- `AUTH_ADMIN_CONTROL_ENABLED=true`
- `AUTH_ADMIN_CONTROL_API_KEYS_JSON`
- `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`
- `AUTH_ADMIN_CONTROL_MAX_SKEW_SECONDS`
- `AUTH_ADMIN_CONTROL_NONCE_TTL_SECONDS`
- `AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS`

`AUTH_ADMIN_CONTROL_API_KEYS_JSON` must contain at least two active keys bound
to two distinct canonical human identities:

```json
[
  {
    "id": "ops-admin-control-2026-04-a",
    "secret": "stored-in-secret-manager",
    "active": true,
    "humanPrincipalId": "agroasys-user:operator-a"
  },
  {
    "id": "ops-admin-control-2026-04-b",
    "secret": "stored-in-secret-manager",
    "active": true,
    "humanPrincipalId": "agroasys-user:operator-b"
  }
]
```

`humanPrincipalId` must be a stable, lowercase identity issued by the approved
identity authority, not a display name or caller-supplied request field. Two
credentials assigned to the same human still represent one approval principal.
Each credential must be assigned to one human and must never be shared.

Secrets must be stored in the production secret manager. They must not be
stored in repo files, shell history, tickets, dashboards, or chat transcripts.

## Request Signing

Every admin-control request must include:

- `X-Api-Key`: the allowed API key ID
- `X-Timestamp`: current Unix timestamp in seconds
- `X-Nonce`: unique random nonce
- `X-Signature`: HMAC-SHA256 signature
- `Content-Type: application/json`

Canonical string:

```text
METHOD
PATH
QUERY
SHA256_HEX_BODY
TIMESTAMP
NONCE
```

The signature is `HMAC_SHA256(secret, canonical_string)` encoded as lowercase
hex. Nonces are persisted in `auth_admin_control_nonces`; replayed nonces are
rejected.

## Durable Admin Grant

A grant is proposed by one human and applied only when a different human
approves its exact evidence digest. Each request is signed with the human's own
admin-control key. Propose:

```text
POST /api/auth/v1/admin/authority-changes/propose
```

```json
{
  "accountId": "agroasys-user:123",
  "change": "grant",
  "environment": "staging",
  "orgId": "agroasys-ops",
  "expiresAt": "2026-11-13T00:00:00.000Z",
  "approvalTicket": "SEC-1234",
  "reason": "SEC-1234 approved durable admin grant for production incident commander"
}
```

- `environment` must equal the service's `COTSEL_ENVIRONMENT`; a grant for any
  other environment is refused with `403` and never applies elsewhere.
- `expiresAt` must be between one hour and `AUTH_ADMIN_GRANT_MAX_TTL_SECONDS`
  (default 30 days) from now. Renew a grant by proposing and approving a new one
  before it expires; when it expires, the account's sessions are revoked on next
  use and exchange refuses it.
- One change may be pending per account and environment. Resubmitting identical
  evidence returns the same pending change.

The response carries `changeId` and `evidenceDigest`. The approver reviews the
pending change (`GET /api/auth/v1/admin/authority-changes?state=pending`) and
approves it:

```text
POST /api/auth/v1/admin/authority-changes/approve
```

```json
{
  "changeId": "6c1f0f0e-1d0b-4d5e-9a63-6a52b0a1b7f2",
  "evidenceDigest": "<evidenceDigest from the proposal>",
  "reason": "SEC-1234 second approver verified ticket and scope"
}
```

The proposer cannot approve their own change (`403`), and a digest that does not
match the pending change is refused. Approval makes the profile a durable
administrator (creating it if needed), clears any break-glass elevation, and
records `admin_authority_change_applied` with both humans, both key IDs, the
evidence digest, and the account's authority before and after.

Either human may withdraw a pending change:

```text
POST /api/auth/v1/admin/authority-changes/cancel
```

```json
{ "changeId": "6c1f0f0e-1d0b-4d5e-9a63-6a52b0a1b7f2", "reason": "SEC-1234 withdrawn" }
```

`reason` must include a ticket, incident, or change reference. Vague reasons
such as `admin setup` are not acceptable. Applied and cancelled changes are
immutable.

## Durable Admin Revocation

Planned revocation uses the same two-person flow with `change: "revoke"` and the
role the account returns to:

```json
{
  "accountId": "agroasys-user:123",
  "change": "revoke",
  "environment": "staging",
  "resultingRole": "buyer",
  "approvalTicket": "SEC-1235",
  "reason": "SEC-1235 approved durable admin revocation after access review"
}
```

When the revocation is approved, the auth service sets the resulting role,
revokes every active session for the profile, and revokes its signer bindings.

For containment, do not wait for a second human: deactivate the profile (below).
Deactivation is single-person by design so that authority can always be removed
immediately.

Applied grants emit `auth.durable_admin_provisioned`. Applied revocations and
deactivation emit `auth.durable_admin_revoked`. Reconcile both against
`auth_admin_audit_events` and `admin_authority_changes` during access review.

## Operator Signer Authority

Provision a signer only after the durable admin profile and named custody
evidence are approved.

Proposal endpoint:

```text
POST /api/auth/v1/admin/signers/propose
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "walletAddress": "0x1111111111111111111111111111111111111111",
  "actionClass": "governance",
  "environment": "staging",
  "custodianName": "Named custodian",
  "approvalTicket": "COTSEL-641",
  "notes": "Hardware-wallet address verified on the device display",
  "reason": "COTSEL-641 approved staging governance signer"
}
```

The proposal remains `pending` and grants no session signer authorization. A
different authenticated human principal must approve its exact evidence digest:

```text
POST /api/auth/v1/admin/signers/approve
```

```json
{
  "bindingId": "binding-id-from-proposal",
  "evidenceDigest": "canonical-sha256-from-proposal",
  "reason": "COTSEL-641 independent custody approval"
}
```

Self-approval is rejected even if the same person uses a second API key. The
environment must be exact; `*` is rejected. The wallet must be a lowercase EVM
address in storage. The auth service never stores private keys, seed phrases,
PINs, device serial numbers, or recovery material.

Read back active records through:

```text
GET /api/auth/v1/admin/signers?accountId=<account>&active=true
```

Revoke through:

```text
POST /api/auth/v1/admin/signers/revoke
```

with `bindingId` and a specific `reason`. Revoked records and original approval
evidence remain immutable. Existing sessions resolve signer authority from the
database on each session lookup, so a revoked binding is no longer returned.

## Deactivation

Endpoint:

```text
POST /api/auth/v1/admin/profiles/deactivate
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "reason": "INC-2222 operator account disabled during credential compromise investigation"
}
```

Deactivation clears break-glass elevation, marks the profile inactive, and
revokes active sessions for the target profile.

## Evidence Retention

Retain all of the following:

- change ticket or incident ID
- approver identity and timestamp
- executor service-auth API key ID
- proposer and approver canonical human principal IDs
- request body without secret values
- response status and response body
- resulting row in `auth_admin_audit_events`
- resulting immutable signer-register record for signer changes
- session revocation evidence from the audit metadata

Audit rows are the source of truth for Cotsel-local durable role changes.
Request logs are supporting evidence only.

## Key Rotation

Rotate admin-control API keys:

- before first production enablement
- at least every 90 days
- immediately after operator departure or suspected exposure
- after break-glass use if the same key had emergency access

Rotation steps:

1. Create a new secret in the production secret manager.
2. Add the new key record to `AUTH_ADMIN_CONTROL_API_KEYS_JSON` with
   `active=true` and the same canonical `humanPrincipalId` as the credential it
   replaces.
3. Add the new key ID to `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`.
4. Deploy to staging and verify one signed request against a designated staging
   test account, using `role: "buyer"` and a reason that references the key
   rotation ticket.
5. Set the old key record to `active=false` and remove it from the allowlist.
6. Deploy and verify old-key rejection by replaying the same staging test
   request with the old key and confirming HTTP 401 with no new audit row.
7. Attach verification evidence to the rotation ticket.

## Review Cadence

Durable admin grants and active signer bindings must be reviewed monthly and
after every incident. The reviewer verifies current business justification,
named custody, action class, environment, approval evidence, and matching
`auth_admin_audit_events` records.
