# Task E staging settlement boundary evidence

## Executive status

Task E is complete for the staging service-auth boundary.

This record covers the live AWS staging runtime on 2026-08-21. It records
non-secret evidence only. It does not approve or replace the Base Sepolia
contract deployment gate in Cotsel issue #639.

## Scope

This evidence proves the authenticated service boundary between:

- Agroasys backend and the Cotsel gateway.
- Cotsel gateway and the Agroasys backend callback receiver.

## Runtime identity

| Field                   | Value                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| AWS account             | `655177116834`                                                    |
| AWS region              | `ap-south-1`                                                      |
| Cotsel ECS cluster      | `cotsel-staging`                                                  |
| Cotsel ECS service      | `cotsel-staging-gateway`                                          |
| Cotsel task definition  | `cotsel-staging-gateway:4`                                        |
| Cotsel execution role   | `arn:aws:iam::655177116834:role/cotsel-staging-gateway-execution` |
| Cotsel task role        | `arn:aws:iam::655177116834:role/cotsel-staging-gateway-task`      |
| Backend ECS cluster     | `agroasys-staging`                                                |
| Backend ECS service     | `agroasys-staging-api`                                            |
| Backend task definition | `agroasys-staging-api:5`                                          |
| Backend execution role  | `arn:aws:iam::655177116834:role/agroasys-staging-execution`       |
| Backend task role       | `arn:aws:iam::655177116834:role/agroasys-staging-task-api`        |

## Secret references

| Direction                          | Credential ID                 | Secret reference                                                                                                    |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Backend to Cotsel gateway          | `agroasys-backend-staging-v1` | `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-ingress-mO4FwK`  |
| Cotsel gateway to backend callback | `cotsel-gateway-staging-v1`   | `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/gateway-settlement-callback-4ccaJW` |
| Backend application configuration  | `N/A`                         | `arn:aws:secretsmanager:ap-south-1:655177116834:secret:agroasys/staging/app/config-FhOt0E`                          |

The two service-auth directions use different credential pairs. The secret
values are not recorded in this file.

## IAM and injection model

ECS injects secret values into containers from AWS Secrets Manager.

The Cotsel gateway execution role can read only the gateway startup secrets
required by the running task. The Cotsel gateway task role has no attached or
inline Secrets Manager policy.

The Agroasys backend execution role can read the backend app-config secret and
database URL secret used by ECS injection. The backend application task role has
no Secrets Manager read permission for the Cotsel credentials.

Terraform tracks secret identities only. Terraform state listing showed
`aws_secretsmanager_secret` resources and no `aws_secretsmanager_secret_version`
resources for these Cotsel and backend application secrets.

## Authentication protocol

The shared service-auth verifier signs this canonical string:

```text
HTTP method
request path
query string
SHA-256 body hash
Unix timestamp seconds
nonce
```

The HMAC uses SHA-256 hex output. The request carries the non-secret API key ID,
timestamp, nonce, and signature in headers.

## Replay protection

| Direction                          | Store                                | Replay behavior                                    |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------- |
| Backend to Cotsel gateway          | Postgres table `service_auth_nonces` | Atomic insert with `(api_key, nonce)` primary key. |
| Cotsel gateway to backend callback | Redis                                | Atomic `SET NX EX` with configured TTL.            |

The configured timestamp skew is 300 seconds. The configured nonce TTL is
600 seconds.

## Live proof results

| Proof                  | Result   | Evidence                                                                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Gateway health         | HTTP 200 | `GET https://cotsel.sys.agroasys.com/api/dashboard-gateway/v1/healthz`, request ID `10cabf9f-a4ad-480a-95fa-b37edcbe205e` |
| Signed backend request | HTTP 200 | `GET /api/dashboard-gateway/v1/settlement/capabilities`, request ID `batch9-replay-8b159594b0a8`                          |
| Tampered signature     | HTTP 401 | Error code `AUTH_INVALID_SIGNATURE`, request ID `batch9-tamper-fae5fa546f1b`                                              |
| Nonce replay           | HTTP 401 | Error code `AUTH_NONCE_REPLAY`, request ID `batch9-replay-8b159594b0a8`                                                   |
| Real callback delivery | HTTP 201 | Delivery ID `126d7e51-96fe-466c-a795-717810f7c54d`, event ID `2b4a8abf-5e80-4653-b4e7-0d0668027569`                       |

The callback proof used the real Cotsel callback sender path. It did not use a
manually manufactured backend HTTP request.

## Backend callback persistence proof

The backend recorded the controlled staging callback against handoff ID `1`.

| Field                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| Cotsel handoff ID       | `ea1698e2-19f5-40cd-8e61-62cc6481642a`        |
| Backend handoff ID      | `1`                                           |
| Backend handoff status  | `dispatched`                                  |
| Backend control state   | `pending_reconciliation`                      |
| Backend provider status | `staging_callback_proof`                      |
| Execution event ID      | `1`                                           |
| Source system           | `cotsel`                                      |
| Source event ID         | `cotsel:2b4a8abf-5e80-4653-b4e7-0d0668027569` |
| Occurred at             | `2026-08-21T11:06:00.859Z`                    |

## Validation performed

The following checks were performed without printing secret values:

```bash
aws sts get-caller-identity
aws ecs describe-task-definition --task-definition cotsel-staging-gateway:4
aws ecs describe-task-definition --task-definition agroasys-staging-api:5
aws iam get-role-policy --role-name cotsel-staging-gateway-execution
aws iam get-role-policy --role-name agroasys-staging-execution
aws iam get-role-policy --role-name agroasys-staging-task-api
terraform state list
npm --prefix shared-auth test
npm --prefix gateway run test -- --runInBand
npm test -- --runInBand src/modules/fulfillment-settlement/settlement-handoff/services/cotsel-settlement-callback-auth.service.spec.ts src/modules/fulfillment-settlement/settlement-handoff/guards/cotsel-settlement-callback.guard.spec.ts
```

GitHub checks passed on these heads:

- Cotsel `987c70d63114`.
- Agroasys backend `c5857971254f`.

## Remaining program boundary

Task E is complete. Task F RPC and Cotsel issue #639 remain separate gates.

Do not treat any Base Sepolia contract address as accepted staging truth until
Task F RPC is complete and #639 has independent deployment acceptance.
