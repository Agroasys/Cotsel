# Controlled-pilot launch profile

`integration/base-sepolia-pilot-launch-profile.json` is the versioned Cotsel launch profile for the Base Sepolia controlled pilot (issue #613, SOW 3.3 and 3.4). It pins the non-secret boundary of the pilot environment:

- release identity source (`GATEWAY_COMMIT_SHA` from the workflow commit), candidate manifest schema, release authority profile and rollback target;
- chain ID, settlement runtime, escrow and USDC addresses, deployment block and runtime bytecode digest, cross-checked against the accepted `integration/base-sepolia-staging-contract.json`;
- RPC mode with a required independent fallback;
- settlement-ingress HMAC policy (skew and nonce window) and every authenticated downstream service;
- the settlement callback URL and contract versions, cross-checked against `integration/release-manifest.json`;
- sponsored-execution custody mode, fail-closed capacity and gas/fee/cost ceilings, plus their WP-0 approval state;
- feature flags that must stay fixed for the pilot (contract address required, no Oracle-only inspection acceptance, rate limiting fail-closed);
- which surfaces are public through CloudFront and WAF (gateway only) and which are private or loopback;
- the side-effect-free readiness and liveness probes and the dependencies readiness must report.

Secrets are named by their Secrets Manager reference only. The validator rejects anything in a reference field that looks like a URL, key or other secret value. The structural contract is `integration/pilot-launch-profile.schema.json`.

## Status and promotion

The profile is checked in as `pending-acceptance` and its sponsorship approval is `pending`. Neither value is evidence of pilot readiness. Only the independent acceptance owner may move the profile to `accepted`, and only after the deployment owner supplies release-bound evidence for the exact candidate. Sponsorship limits move to `approved` only with a link to the recorded WP-0 decision. A change to any invalidation trigger listed in the profile returns it to `pending-acceptance`.

## Checks

The static check validates the profile against the repository identities it depends on. The drift tests fail when the staging Terraform task definition, the provisioned secret inventory, the load-balancer health check or the gateway readiness contract stops matching the profile:

```bash
pnpm run launch-profile:check
```

The launch-readiness check also validates a resolved gateway runtime environment against the profile. It reads only the environment it is given and never contacts the chain, RPC or any provider, so it cannot broadcast or mutate settlement state:

```bash
node scripts/validate-pilot-launch-profile.mjs --env-file path/to/gateway.env
node scripts/validate-pilot-launch-profile.mjs --runtime-env --require-promotable
```

`--require-promotable` additionally fails unless the profile is `accepted` with approved sponsorship limits. Use it before any pilot promotion.

The command prints one JSON report that carries the profile SHA-256 and every finding, and exits non-zero on any failure. Values of secret-bearing variables are never printed. Findings report them only as missing or malformed. The report is safe to attach to the candidate evidence index.

Runtime failures that fail closed include: wrong chain or settlement runtime, drifted escrow or USDC address, a non-pinned commit such as `local-dev`, missing or same-host fallback RPC, non-https RPC, missing or empty settlement service keyset, insecure downstream auth, skew or nonce drift, missing downstream service credentials, callback URL or credential mismatch, Oracle-only inspection acceptance, fail-open rate limiting, and sponsored execution without approved limits, with raw key custody, without fail-closed capacity or with caps above the profile ceilings.

## Out of scope

This profile does not authorize Base mainnet, does not replace candidate-bound evidence or the acceptance decision, and is not a settlement authority. Live probes of chain identity, signer funding and nonce state remain the job of gateway `/readyz` and the existing Base Sepolia verification scripts.
