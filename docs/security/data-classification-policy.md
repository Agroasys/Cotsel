# Data Classification Policy For Logs And Runbooks

## Purpose
Define which data classes may appear in generic service logs, operator evidence
packets, and runbook examples, and which classes must remain masked,
referenced, or excluded entirely.

This policy is the source of truth for observability and documentation surfaces
that align to `docs/observability/logging-schema.md`.

## Scope
This policy applies to:

- service logs
- incident artifacts
- operator audit packets
- runbook field lists and examples
- OpenAPI examples and surrounding operator-facing schema notes

This policy does not relax stricter retention or access controls on ledgers,
databases, or compliance evidence stores.

## Classification levels

| Class | Meaning | Generic logs/runbooks |
| --- | --- | --- |
| `public_operational` | Non-sensitive operational metadata such as `tradeId`, `requestId`, `traceId`, `txHash`, environment, route, and service name. | Allowed |
| `internal_operational` | Internal workflow metadata such as actor role, masked account references, provider references, ticket references, and normalized outcome/error codes. | Allowed when operationally necessary |
| `confidential_regulated` | Regulated or partner-sensitive data such as compliance subject records, bank account identifiers, and full payout instructions. | Reference-only, hashed, or masked form only |
| `restricted_secret` | Secrets or authentication material such as private keys, seed phrases, bearer tokens, API secrets, and HMAC secrets. | Never allowed |

## Allowed in generic logs and runbooks

Allowed examples:

- `tradeId`, `actionKey`, `requestId`, `correlationId`, `traceId`
- `txHash`, `blockNumber`, `chainId`, `networkName`
- `actorRole`, `actorWallet`
- `intent`, `outcome`, `errorCode`
- `providerRef`, `documentRef`, `evidenceRef`
- masked references such as `accountLast4`, `ibanLast4`, or equivalent bounded suffixes

Rules:
- Use stable references, hashes, or masked suffixes instead of raw subject data.
- Prefer `providerRef` or `subjectRef` over full compliance payloads.
- Prefer `ticketRef` or evidence URI over pasted incident chat content.

## Prohibited in generic logs and runbooks

Never place these classes in generic logs, runbook examples, incident templates,
or operator audit templates:

- raw private keys or wallet export material
- seed phrases or mnemonics
- bearer tokens, session tokens, refresh tokens
- API secrets, HMAC secrets, or full signed canonical strings
- raw bank account numbers, routing numbers, IBANs, SWIFT/BIC values
- full KYB/KYT/KYC payloads or raw sanctions-match payloads
- passport numbers, national IDs, dates of birth, or full residential addresses

## Allowed transformations for sensitive domains

| Domain | Allowed representation | Disallowed representation |
| --- | --- | --- |
| Wallet/auth | `actorWallet`, `actorRole`, masked principal ref | private key, seed phrase, bearer token |
| Banking | `accountLast4`, `providerRef`, payout ticket ref | full account number, routing number, IBAN, SWIFT |
| Compliance | `subjectRef`, `providerRef`, `decisionId`, `evidenceRef`, normalized reason code | raw subject profile, raw provider request/response payload |
| Signatures | `txHash`, `signatureRef`, normalized verification outcome | full HMAC secret, full canonical string, signing secret |

## Enforcement

Deterministic CI enforcement is performed by:

- `scripts/tests/data-classification-guard.mjs`
- `.github/workflows/release-gate.yml` in `ci/docs-profile-guard`

Current guard coverage:

- all operator-facing docs under `docs/api`
- all incident templates under `docs/incidents`
- all observability contracts under `docs/observability`
- all runbook examples and field lists under `docs/runbooks`
- `gateway/src/logging/logger.ts`
- `oracle/src/utils/logger.ts`
- `treasury/src/utils/logger.ts`
- `reconciliation/src/utils/logger.ts`

If a new operator-facing log contract or evidence template is introduced, extend
the guard in the same change instead of relying on reviewer memory.
