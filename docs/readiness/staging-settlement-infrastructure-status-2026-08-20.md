# Staging settlement infrastructure status — 2026-08-20

## Executive verdict

Partially complete.

The AWS foundation for Cotsel staging exists in `ap-south-1`, but the Cotsel
gateway runtime is not deployed yet. Therefore Task E cannot be accepted, Task F
RPC cannot be accepted, and issue #639 must remain blocked from deployment.

This note records repository and runtime truth for Batches 0-2 of the staging
settlement-infrastructure plan. It deliberately records no secret values.

## Batch 0 — repository, issue, AWS, and deployment truth

### What was believed before inspection

- Cotsel staging should use AWS, not GCP.
- The staging gateway should be reachable at
  `https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1`.
- Task E needs two independent service-auth credential pairs.
- Task F needs managed Base Sepolia RPC primary and fallback endpoints.
- Contract deployment must wait for Task E and Task F RPC evidence.

### What repository inspection proved

- `infra/terraform/staging-platform` creates foundation resources only:
  ECS cluster, ECR repositories, logs, KMS, ALB, and Secrets Manager containers.
- `infra/terraform/staging-platform` does not define an ECS service, task
  definition, task execution role, or application task role.
- The platform root intentionally creates secret identities only. It does not
  create secret versions, so plaintext does not enter Terraform state.
- `gateway/src/config/env.ts` reads:
  - `GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON`
  - `GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS`
  - `GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS`
  - `GATEWAY_SETTLEMENT_CALLBACK_ENABLED`
  - `GATEWAY_SETTLEMENT_CALLBACK_URL`
  - `GATEWAY_SETTLEMENT_CALLBACK_API_KEY`
  - `GATEWAY_SETTLEMENT_CALLBACK_API_SECRET`
- `shared-auth/src/serviceAuth.js` requires
  `GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON` to be a JSON array.
- Each API-key record must contain `id`, `secret`, and `active`.
- `active` must be a boolean value, not a string.
- The HMAC canonical string is:

  ```text
  METHOD
  path
  query
  bodySha256
  timestamp
  nonce
  ```

- The HMAC output is SHA-256 hex.
- The Cotsel gateway uses `createGatewayServiceAuthNonceStore(pool)`, backed by
  gateway Postgres, for settlement ingress nonce replay protection.
- The gateway callback dispatcher signs outbound callbacks with the same
  canonical string and sends:
  - `X-Api-Key`
  - `X-Timestamp`
  - `X-Nonce`
  - `X-Signature`
- The backend callback receiver is:
  `/api/v1/settlement-handoffs/cotsel/callbacks/execution-events`.
- The backend callback guard verifies the same canonical HMAC shape and uses
  Redis `SET ... EX ... NX` for callback nonce replay protection.
- Backend ECS runtime injects app configuration with ECS `secrets.valueFrom`.
  Therefore the backend ECS task execution role, not the application task role,
  reads the app-config secret at task startup.
- Backend app-config currently expects Cotsel values as JSON keys in
  `agroasys/staging/app/config`.
- Cotsel #639 remains open and requires independent acceptance before any
  contract address becomes staging truth.

### What AWS runtime inspection proved

- AWS account: `655177116834`.
- Confirmed Cotsel staging region: `ap-south-1`.
- ECS cluster: `cotsel-staging`.
- ECS cluster status: `ACTIVE`.
- ECS capacity provider: `FARGATE`.
- Active ECS services: `0`.
- Running ECS tasks: `0`.
- Pending ECS tasks: `0`.
- ECS service ARNs: none.

### What changed in this batch

- No runtime configuration or secret value changed in this batch.
- The repository now has this status note as the canonical batch record.

### Validation actually performed

- Inspected Cotsel source and Terraform with `rg` and `sed`.
- Inspected backend source and Terraform with `rg` and `sed`.
- Ran `aws sts get-caller-identity --profile agroasys`.
- Ran `aws ecs describe-clusters --region ap-south-1 --clusters cotsel-staging`.
- Ran `aws ecs list-services --region ap-south-1 --cluster cotsel-staging`.
- Ran `aws secretsmanager list-secrets --region ap-south-1` with the Cotsel
  staging secret-name filter.

### Evidence produced

- This file.
- GitHub Actions Terraform evidence:
  - Cotsel staging-platform apply: `32385662426`.
  - Cotsel staging-platform no-op verification plan: `32386309992`.
- Backend governance-boundary checks:
  - CI Pipeline: `32386745282`.
  - Release Image: `32386745151`.
  - Security Hygiene: `32386745187`.

### Unresolved

- There is no deployed Cotsel ECS runtime service yet.
- There is no Cotsel gateway task definition to inspect.
- There are no Cotsel gateway execution-role or task-role ARNs yet.
- There is no live gateway revision for Task E proofs.

## Batch 1 — Cotsel staging runtime region

### Confirmed Cotsel staging foundation region

`ap-south-1`.

### Runtime evidence

The ECS cluster `cotsel-staging` exists in `ap-south-1`, but it has no active
services and no running tasks.

### Batch status

Partially complete.

The region for the AWS staging foundation is confirmed. The runtime region for
the gateway service cannot be fully accepted until an ECS service and task
definition exist.

## Batch 2 — canonical service credential pairs

### Secret identities created by AWS foundation

The staging platform root created the secret containers below. Values were not
written by Terraform.

| Direction                                   | Secret name                                            | Secret ARN                                                                                                          | Identifier                    |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Backend to Cotsel gateway                   | `/agroasys/staging/cotsel/gateway-settlement-ingress`  | `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-ingress-mO4FwK`  | `agroasys-backend-staging-v1` |
| Cotsel gateway to backend callback receiver | `/agroasys/staging/cotsel/gateway-settlement-callback` | `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-callback-4ccaJW` | `cotsel-gateway-staging-v1`   |

### Required value shape

The gateway ingress credential must render to:

```json
[
  {
    "id": "agroasys-backend-staging-v1",
    "secret": "<generated secret>",
    "active": true
  }
]
```

The callback credential must provide:

```json
{
  "apiKey": "cotsel-gateway-staging-v1",
  "apiSecret": "<generated secret>"
}
```

The same secret value must not be reused across these two directions.

### Batch status

Partially complete.

The secret containers and identifiers exist. The actual cryptographic secret
values must be generated and written through the approved bootstrap/rotation
path after the Cotsel runtime root defines how ECS injects them.

## Task E implementation map

| Credential                | Secrets Manager object                                                                                                 | IAM reader                                                                                                   | ECS/runtime consumer                                                  | Parser                                                                   | Use                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Backend to Cotsel gateway | Backend `agroasys/staging/app/config` keys plus Cotsel `/agroasys/staging/cotsel/gateway-settlement-ingress`           | Backend ECS execution role for backend injection; future Cotsel gateway execution role for gateway injection | Backend API and settlement workers; future Cotsel gateway task        | Backend `CotselConfigReader`; Cotsel `parseServiceApiKeys`               | Backend signs gateway requests; Cotsel verifies ingress |
| Cotsel gateway to backend | Backend `agroasys/staging/app/config` callback keys plus Cotsel `/agroasys/staging/cotsel/gateway-settlement-callback` | Backend ECS execution role for backend injection; future Cotsel gateway execution role for gateway injection | Backend API callback guard; future Cotsel gateway callback dispatcher | Backend `CotselSettlementCallbackAuthService`; Cotsel gateway env parser | Cotsel signs callbacks; backend verifies callbacks      |

## Task F RPC implementation map

| RPC secret                | Secrets Manager object                               | Current consumer model                                                                                                                                  | Status                                                                   |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Primary Base Sepolia RPC  | `/agroasys/staging/cotsel/rpc-base-sepolia-primary`  | Gateway `GATEWAY_RPC_URL`, oracle `RPC_URL`, reconciliation `RPC_URL`, indexer `RPC_ENDPOINT`; backend currently uses `COTSEL_SETTLEMENT_CHAIN_RPC_URL` | Secret container exists; endpoint value and live chain proof remain open |
| Fallback Base Sepolia RPC | `/agroasys/staging/cotsel/rpc-base-sepolia-fallback` | Gateway `GATEWAY_RPC_FALLBACK_URLS`, oracle `RPC_FALLBACK_URLS`, reconciliation `RPC_FALLBACK_URLS`, indexer `RPC_FALLBACK_ENDPOINTS`                   | Secret container exists; endpoint value and failover proof remain open   |

## Task E live proof status

| Proof                        | Status  | Reason                                                     |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| Health                       | Blocked | No Cotsel gateway ECS service is deployed.                 |
| Signed backend request       | Blocked | No live gateway runtime can verify the signed request.     |
| Tampered signature rejection | Blocked | No live gateway runtime can reject it.                     |
| Nonce replay rejection       | Blocked | No live gateway runtime can persist and reject the replay. |
| Real callback                | Blocked | No live gateway runtime can emit the callback.             |

## Task F and #639 status

- Task F RPC remains open because primary and fallback endpoint values are not
  live-validated and no deployed consumers can prove failover.
- Base Sepolia chain ID is `84532`.
- The contract deployment config pins Base Sepolia USDC to
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- Cotsel #639 remains open.
- No contract deployment is authorized before Task E and Task F RPC acceptance.

## Immediate next engineering work

1. Add the Cotsel staging runtime Terraform root or extend the existing root with
   ECS task definitions, ECS services, execution roles, task roles, container
   secret injection, listener forwarding, and least-privilege secret access.
2. Generate the two credential pairs through the approved secret bootstrap path.
3. Populate only Secrets Manager, not Terraform variables or state.
4. Deploy the gateway runtime to `cotsel-staging`.
5. Run Task E live proofs.
6. Populate and validate primary and fallback Base Sepolia RPC endpoints.
7. Prove RPC failover in staging.
8. Only then proceed to #639 pre-deployment gate.
