# Secrets And Token Rotation Runbook

## Purpose

Define the minimum operational procedure for rotating Cotsel runtime secrets and service-auth material without inventing ad hoc steps during an incident.

This runbook covers:

- service-auth API keys and HMAC secrets
- bearer or webhook-like shared secrets used between services
- database runtime and migration passwords
- environment-managed runtime secrets

It does not replace the governance signer custody runbook:

- `docs/runbooks/gateway-governance-signer-custody.md`

## Core rules

- secrets live in environment management only
- `.env*` templates in repo must contain placeholders only
- never commit, paste, or screenshot live secrets into repo artifacts
- never log full secret values or raw bearer tokens
- rotate immediately on suspected exposure; do not wait for perfect certainty

## Secret classes in scope

- trusted upstream session-exchange service auth material
- gateway downstream service auth material
- settlement ingress shared auth material
- service-local inbound auth material
- database runtime and migration passwords

Exact variable names live in:

- `docs/runbooks/service-auth-matrix.md`
- service env examples under `env/` and each service package

## Rotation workflow

1. Identify the secret class and blast radius.
2. Decide whether rotation is emergency or scheduled.
3. Mint replacement secret material outside the repo.
4. Update the authoritative secret store or deployment system.
5. Restart or roll the affected service set in a controlled order.
6. Verify health and auth behavior.
7. Revoke or delete the old material.
8. Record the evidence and incident/change reference.

## Safe rollout order

### Shared caller/callee service auth

For a shared downstream service-auth pair:

1. add new secret to caller and callee configuration
2. deploy callee so it accepts the new secret
3. deploy caller so it starts using the new secret
4. verify request success and replay protection
5. remove old secret from callee
6. remove old secret from caller

If the service supports only one active secret at a time, expect a brief maintenance window and fail closed rather than silently running insecurely.

### Database passwords

1. create or set the replacement runtime/migration password
2. update deployment secret store
3. roll the service using the credential
4. verify readiness and schema access
5. revoke the previous credential

## Verification checklist

After rotation, verify:

- service health/readiness endpoints are green
- the caller can authenticate successfully
- wrong or old credentials now fail
- no secret value appears in logs
- incident/change record contains time, owner, and affected services

## Emergency triggers

Rotate immediately if:

- a secret appears in logs, screenshots, tickets, or shell history
- an `.env` file with live values is shared outside approved scope
- a CI artifact or support bundle includes credential material
- unauthorized service requests are observed and attribution is uncertain

## Evidence to capture

- reason for rotation
- affected secret class
- affected services
- rollout start and end time
- verifier name
- health/readiness proof
- reference to incident or change ticket

## What not to do

- do not rotate by editing repo examples
- do not leave both old and new secrets active indefinitely
- do not skip verification because a deploy succeeded
- do not claim rotation complete until the old secret is revoked

## Related docs

- `docs/runbooks/production-readiness-checklist.md`
- `docs/runbooks/service-auth-matrix.md`
- `docs/runbooks/runtime-truth-deployment-guide.md`
- `docs/runbooks/gateway-governance-signer-custody.md`
