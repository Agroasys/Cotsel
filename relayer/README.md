# Gasless relayer

## Purpose

The relayer is the only Cotsel workload that can sign with the gasless-relayer KMS key.
It signs approved transaction intents. It does not use an RPC endpoint or broadcast transactions.

The gateway performs these actions:

- Validate the user or operator authorization.
- Simulate the transaction.
- Select the nonce and fee values.
- Send an HMAC-authenticated signing request.
- Verify the returned signed transaction.
- Persist the prepared transaction before broadcast.
- Broadcast and monitor the transaction.

## Security boundary

The relayer accepts only approved contract methods and the canonical staging addresses.
It rejects wrong signers, chains, recipients, selectors, values, fees, gas limits, and intent hashes.

The relayer consumes each HMAC nonce once. It also consumes each signing `requestId` once.
Production uses Redis for both replay controls.

Never configure these values in the relayer:

- `RELAYER_PRIVATE_KEY`
- `GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY`
- `GATEWAY_EXECUTOR_PRIVATE_KEY`

Never grant the relayer task role access to the Oracle KMS key.
Never grant the gateway, administrator, treasury, or deployer roles access to either signer key.

## Required configuration

Set these non-secret variables:

- `RELAYER_CHAIN_ID`
- `RELAYER_ESCROW_ADDRESS`
- `RELAYER_USDC_ADDRESS`
- `RELAYER_KMS_KEY_ID`
- `RELAYER_KMS_EXPECTED_ADDRESS`
- `RELAYER_REDIS_URL` using `rediss://` in production
- `RELAYER_SIGNER_CUSTODY_MODE=kms`

Set `RELAYER_API_KEYS_JSON` from the protected `gateway-managed-signer` secret.
The secret must contain `id`, `secret`, and `active` fields. Every HMAC `secret` must be at
least 32 bytes and generated through the controlled bootstrap or rotation procedure.

## HTTP interface

- `GET /api/relayer/health` is an unauthenticated liveness endpoint.
- `GET /api/signers/gasless-relayer/address` requires HMAC authentication.
- `POST /api/signers/gasless-relayer/sign-transaction` requires HMAC authentication.

The signing endpoint returns a signed transaction. It never broadcasts it.

## Activation gates

Do not enable gasless execution until all gates pass:

1. Derive the KMS address through `GetPublicKey`.
2. Independently verify the address.
3. Populate the protected service-auth secret.
4. Review a fresh Terraform plan.
5. Confirm only the relayer task role has relayer-key signing permission.
6. Confirm Oracle and relayer cross-signing attempts are denied.
7. Confirm gateway, administrator, treasury, and deployer signing attempts are denied.
8. Capture CloudTrail evidence for permitted and denied calls.
9. Complete the Base Sepolia failure and recovery rehearsal.

Keep `GATEWAY_GASLESS_EXECUTION_ENABLED=false` until these gates are accepted.
