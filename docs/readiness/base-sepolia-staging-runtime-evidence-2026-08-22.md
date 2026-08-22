# Base Sepolia staging runtime evidence — 2026-08-22

Status: evidence packet prepared; independent review still required before this
deployment becomes accepted staging truth.

## Scope

This records the current evidence for Cotsel issue #639 after wiring the
staging runtime to the newly deployed Base Sepolia contract.

This document intentionally excludes:

- private keys
- HMAC secrets
- authenticated RPC URLs
- API tokens
- full signed request headers
- full sensitive callback payloads

## Prior trust boundary evidence

Task E service-to-service authentication was previously proven against the live
staging gateway:

- gateway health: HTTP 200
- signed backend-to-Cotsel request: accepted
- tampered signature: rejected with `AUTH_INVALID_SIGNATURE`
- replayed nonce: rejected with `AUTH_NONCE_REPLAY`
- real Cotsel-to-backend callback: accepted by the backend callback route

Reference evidence file from the Task E working tree:

`docs/readiness/task-e-settlement-boundary-staging-evidence-2026-08-21.md`

## RPC evidence

Base Sepolia chain identity:

- chain ID: `84532`
- JSON-RPC chain ID: `0x14a34`

Primary RPC:

- provider: Infura / MetaMask Developer
- secret name: `/agroasys/staging/cotsel/rpc-base-sepolia-primary`
- secret ARN: `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/rpc-base-sepolia-primary-XjIaRV`
- AWS region: `ap-south-1`

Fallback RPC:

- provider: Alchemy
- secret name: `/agroasys/staging/cotsel/rpc-base-sepolia-fallback`
- secret ARN: `arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/cotsel/rpc-base-sepolia-fallback-pG6ZlE`
- AWS region: `ap-south-1`

Validation performed:

- primary `eth_chainId`: `0x14a34`
- fallback `eth_chainId`: `0x14a34`
- primary block reads advanced from `45776844` to `45776846`
- fallback block reads advanced from `45776847` to `45776849`
- forced-primary-outage local SDK test used fallback successfully at block
  `45777014`

## Contract deployment evidence

Deployment source commit:

`1b3c64051e3fa29f8f148b24f5ec2537964407d1`

Network:

- name: Base Sepolia
- chain ID: `84532`

Contract:

- name: `AgroasysEscrow`
- address: `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`
- deployment transaction:
  `0xb6af9e63a64fbbdc3f3294bf35c749c59b77a09a12b9f8df3dd4b90b3cfad5df`
- deployment block: `45807259`
- receipt status: `1`
- explorer:
  `https://sepolia.basescan.org/address/0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`
- source verification:
  `https://sepolia.basescan.org/address/0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd#code`

Compiler and artifact:

- compiler: `0.8.34`
- BaseScan compiler: `v0.8.34+commit.80d5c536`
- optimizer: enabled
- optimizer runs: `200`
- ABI SHA-256:
  `572c473d519c81c67d0fe6fa3174439aca53d17f45b9b8438c196bcf916aaed1`
- creation bytecode SHA-256:
  `b3429757821ff6089d330e2c97f69c0fe8ee489d392cced82c689bb5b76b6909`
- artifact deployed-bytecode SHA-256:
  `60a861277ecc63e5b0b08001c8db174677c61d3fe00d82eb33e124d369ee41cc`

Constructor and role configuration:

- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- oracle: `0x440b6efe3f4E0A59A9F199f97C9E4cd9368A178B`
- treasury: `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc`
- treasury payout receiver: `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc`
- relayer: `0xE06E388BaEcFD9FcffD4890ddA552C4245c3aB2b`
- admin 1: `0x0817fe4A674a57af87E39d0CD341b2b5F0158599`
- admin 2: `0xcB1296C7149289CF1Bd0B84ce6D8c0F608E041cD`
- admin 3: `0x13F9507b51A883B1302B555F9530C0F2d1b5bB8f`
- required approvals: `2`

Post-deployment read checks:

- USDC matched constructor input
- oracle matched constructor input
- treasury matched constructor input
- treasury payout receiver matched constructor input
- required approvals: `2`
- paused: `false`
- claims paused: `false`
- oracle active: `true`
- relayer allowed: `true`
- all three configured admins active: `true`

## Runtime convergence evidence

AWS account:

- account: `655177116834`
- region: `ap-south-1`

ECS:

- cluster: `cotsel-staging`
- service: `cotsel-staging-gateway`
- task definition: `cotsel-staging-gateway:13`
- task definition ARN:
  `arn:aws:ecs:ap-south-1:655177116834:task-definition/cotsel-staging-gateway:13`
- running task:
  `arn:aws:ecs:ap-south-1:655177116834:task/cotsel-staging/1e534c8825194020b256912f4032e273`
- rollout state: `COMPLETED`
- desired/running/pending: `1/1/0`

Public runtime checks:

- `GET /api/dashboard-gateway/v1/healthz`: HTTP 200
- `GET /api/dashboard-gateway/v1/readyz`: HTTP 200
- ready dependencies: `postgres`, `auth-service`, `chain-rpc`,
  `indexer-graphql`

Rendered non-secret runtime configuration:

| Container        | Setting                                  | Value                                        |
| ---------------- | ---------------------------------------- | -------------------------------------------- |
| gateway          | `GATEWAY_SETTLEMENT_RUNTIME`             | `base-sepolia`                               |
| gateway          | `GATEWAY_CHAIN_ID`                       | `84532`                                      |
| gateway          | `GATEWAY_ESCROW_ADDRESS`                 | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd` |
| gateway          | `GATEWAY_USDC_ADDRESS`                   | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| gateway          | `GATEWAY_CONTRACT_ADDRESS_REQUIRED`      | `true`                                       |
| gateway          | `GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH` | `false`                                      |
| indexer-pipeline | `CONTRACT_ADDRESS`                       | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd` |
| oracle           | `SETTLEMENT_RUNTIME`                     | `base-sepolia`                               |
| oracle           | `CHAIN_ID`                               | `84532`                                      |
| oracle           | `ESCROW_ADDRESS`                         | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd` |
| oracle           | `USDC_ADDRESS`                           | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| oracle           | `NODE_ENV`                               | `staging`                                    |
| reconciliation   | `SETTLEMENT_RUNTIME`                     | `base-sepolia`                               |
| reconciliation   | `CHAIN_ID`                               | `84532`                                      |
| reconciliation   | `ESCROW_ADDRESS`                         | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd` |
| reconciliation   | `USDC_ADDRESS`                           | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| reconciliation   | `RECONCILIATION_ENABLED`                 | `true`                                       |
| reconciliation   | `NODE_ENV`                               | `staging`                                    |

Runtime log evidence:

- oracle container healthy, `env=staging`
- reconciliation container healthy, `env=staging`
- reconciliation daemon runs completed on chain `84532`
- indexer pipeline caught up to Base Sepolia blocks after deployment

## Secret handling evidence

Rendered ECS task definition revision 13 was scanned for known sensitive input
fragments:

- user-pasted wallet private keys: absent
- authenticated Infura URL fragment: absent
- authenticated Alchemy URL fragment: absent
- BaseScan API key: absent

Secrets are injected through ECS `secrets` entries rather than plaintext
environment values.

Secret-bearing settings observed in ECS secret references include:

- RPC primary/fallback references
- gateway service HMAC references
- callback HMAC references
- database credentials
- oracle private-key reference

## Repository changes in this branch

Runtime repair commits:

- `7575398 fix(shared-db): honor Postgres SSL mode`
- `1049672 fix(docker): include pnpm patches in service images`
- `47016df fix(oracle): label escrow address in startup logs`

The final oracle change fixes misleading startup metadata so the service logs
the configured escrow address as `escrowAddress`, not `oracleAddress`.

Validation performed for these commits:

- `pnpm --filter @agroasys/shared-db run test`
- `pnpm --filter @agroasys/shared-db run lint`
- `pnpm --filter oracle run build`
- `pnpm --filter oracle test`

## Remaining acceptance gate

This evidence does not itself accept the deployment as canonical staging truth.

Issue #639 still requires an independent reviewer to compare:

1. approved source commit
2. compiled artifact
3. compiler settings
4. constructor arguments
5. deployment transaction
6. deployed runtime bytecode
7. explorer-verified source
8. configured role addresses
9. configured USDC
10. downstream service configuration
11. indexer/reconciliation state

The reviewer must explicitly return either:

- `ACCEPTED`
- `REJECTED — <reasons>`

## Operational follow-ups

These are not substitutes for the independent review:

- Codify the manually inspected ECS runtime wiring in the canonical IaC path if
  no existing Terraform module owns this Cotsel staging service.
- Replace raw private-key staging custody with the approved team custody model
  before promoting beyond controlled staging.
- Do not use any wallet private key that was pasted into chat for future
  governed deployment authority.
