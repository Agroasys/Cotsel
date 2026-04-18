# Auth Admin Provisioning Runbook

This runbook governs durable Cotsel auth role changes performed through the
auth service admin-control plane.

## Scope

Use this procedure only for Cotsel-local auth profile provisioning,
reactivation, durable role changes, and durable admin revocation. Normal
operator dashboard session issuance remains owned by `agroasys-backend` through
the signed `POST /session/exchange/agroasys` route.

## Authority

- Initiator: Cotsel production operator, security engineer, or release manager
  with an approved ticket.
- Approver: a second production operator or security owner for durable admin
  grants and durable admin revocations.
- Executor: a service principal whose API key ID is listed in
  `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`.
- Trust root: Cotsel auth service verifies signed service-auth headers and
  stores the durable role state in Postgres.

No browser client, dashboard client, or caller-supplied login role is
authoritative for durable admin access.

## Required Configuration

The auth service must be started with:

- `AUTH_ADMIN_CONTROL_ENABLED=true`
- `AUTH_ADMIN_CONTROL_API_KEYS_JSON`
- `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`
- `AUTH_ADMIN_CONTROL_MAX_SKEW_SECONDS`
- `AUTH_ADMIN_CONTROL_NONCE_TTL_SECONDS`
- `AUTH_ADMIN_BREAK_GLASS_MAX_TTL_SECONDS`

`AUTH_ADMIN_CONTROL_API_KEYS_JSON` contains active service-auth key records:

```json
[{ "id": "ops-admin-control-2026-04", "secret": "stored-in-secret-manager", "active": true }]
```

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

## Durable Admin Grant Or Role Change

Endpoint:

```text
POST /api/auth/v1/admin/profiles/provision
```

Body:

```json
{
  "accountId": "agroasys-user:123",
  "role": "admin",
  "email": "operator@example.com",
  "walletAddress": "0x0000000000000000000000000000000000000000",
  "orgId": "agroasys-ops",
  "reason": "SEC-1234 approved durable admin provisioning for production incident commander"
}
```

`reason` must include a ticket, incident, or change reference. Vague reasons
such as `admin setup` are not acceptable.

## Durable Admin Revocation Or Downgrade

Use the same endpoint with a non-admin role:

```json
{
  "accountId": "agroasys-user:123",
  "role": "buyer",
  "reason": "SEC-1235 approved durable admin revocation after access review"
}
```

The auth service revokes active sessions for the target profile when durable
authority changes. Existing sessions must not remain privileged after the role
change.

Durable admin grant events emit `auth.durable_admin_provisioned`. Durable admin
revocation or deactivation emits `auth.durable_admin_revoked`. Both events must
be reconciled against `auth_admin_audit_events` during access review.

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
- request body without secret values
- response status and response body
- resulting row in `auth_admin_audit_events`
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
   `active=true`.
3. Add the new key ID to `AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS`.
4. Deploy to staging and verify one signed request against a designated staging
   test account, using `role: "buyer"` and a reason that references the key
   rotation ticket.
5. Set the old key record to `active=false` and remove it from the allowlist.
6. Deploy and verify old-key rejection by replaying the same staging test
   request with the old key and confirming HTTP 401 with no new audit row.
7. Attach verification evidence to the rotation ticket.

## Review Cadence

Durable admin grants must be reviewed monthly and after every incident. The
reviewer verifies that each active admin has a current business justification,
recent access approval, and a matching `auth_admin_audit_events` trail.
