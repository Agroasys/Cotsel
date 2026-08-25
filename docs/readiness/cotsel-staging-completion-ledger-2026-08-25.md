# Cotsel staging completion ledger

## Purpose and status

Audience: release, security, platform, data, and settlement operators.

Scope: the current AWS staging lane, retained GCP lanes, and their release candidates.

Outcome: provide reproducible, redacted evidence for each required completion gate.

Overall status: **PARTIALLY VERIFIED**.

Observation date: `2026-08-25`.

AWS workload region: `ap-south-1`.

AWS account: `655177116834`.

This ledger does not approve a release. It records current evidence and blocks unproved claims.

Programme gate: [#751](https://github.com/Agroasys/Cotsel/issues/751).

Governing final-acceptance protocol:
`cotsel-forensic-completion-audit-protocol-v1.md`.

Do not put secret values, private keys, authenticated RPC URLs, tokens, cookies, or customer data in this file.

## Evidence rules

Use these claim classifications:

- `VERIFIED`
- `PARTIALLY VERIFIED`
- `NOT IMPLEMENTED`
- `MISCONFIGURED`
- `STALE / LEGACY`
- `BLOCKED`

Use these GCP dispositions:

- `MIGRATED`
- `INTENTIONALLY RETAINED`
- `READY TO DECOMMISSION`
- `BLOCKED / UNKNOWN`

An implementation merge is not release acceptance. A successful workflow is not deployment proof.

## Source and release identities

These identities were queried from GitHub on `2026-08-25`.

| Repository                  | Current default branch | Current default head                       | Classification | Release relationship                                           |
| --------------------------- | ---------------------- | ------------------------------------------ | -------------- | -------------------------------------------------------------- |
| `Agroasys/Cotsel`           | `main`                 | `34251f874d5f983111b97827ca986ac8b1ce3d39` | VERIFIED       | The current ECS images still come from its parent `6052ed...`. |
| `Agroasys/agroasys-backend` | `develop`              | `b9e04ea3ac48105accc260f7b8c85ccb927fba1f` | VERIFIED       | Produces an undeployed backend candidate image.                |
| `Agroasys/Cotsel.dash`      | `main`                 | `93273b52d958441317f2e8f86f26ae3971340a19` | VERIFIED       | Not deployed through the planned AWS dashboard path.           |
| `Agroasys/platform.v1`      | `main`                 | `2f72921d9e4416240cfd427683b997d5cd6c566f` | VERIFIED       | The browser session bridge remains a declared dependency.      |

The checked-in `integration/release-manifest.json` pins older commits. Classify it as `STALE / LEGACY` for this programme candidate.

Do not promote that manifest. Update it only after all candidate commits and deployed artifacts converge.

### Programme change gates

| Repository and PR      | Exact head                                 | Gate state                                                                                                   | Classification     | Required action                                              |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------ |
| `Cotsel#748`           | `44840a8f34c4838ec0b30ded584ba94b54694ba2` | `AvitusI` approved this exact head. GitHub created squash commit `34251f874d5f983111b97827ca986ac8b1ce3d39`. | VERIFIED           | Review the resulting Terraform plan separately.              |
| `Cotsel#746`           | `c74531b1325d3484ac2d03b3b63cf8f64e1106ce` | Checks pass; contract acceptance is absent.                                                                  | BLOCKED            | Obtain independent contract review and an explicit decision. |
| `Cotsel#749`           | `c4e9aef3986abfae52c9347303a6230323080b8d` | Rebased on `main`; the full exact-head release matrix and counterpart review are pending.                    | BLOCKED            | Require every check to pass and obtain exact-head review.    |
| `agroasys-backend#591` | `b6a0368eb03fe9962fcb6484ece1f0926071df92` | Refreshed checks pass; no independent review exists.                                                         | BLOCKED            | Obtain counterpart review before merge.                      |
| `agroasys-backend#592` | `82d732aad061a9e262ca00e62960a5f02e3d4210` | Stacked after `#591`; current-base proof is absent.                                                          | PARTIALLY VERIFIED | Refresh only after `#591` merges.                            |

## Actor and authority record

| Change                          | Implementer or operator                      | Reviewer                                                            | Plan approver          | Applier or deployer                                         | Acceptance authority          | Status                             |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- | ----------------------------- | ---------------------------------- |
| Cotsel Terraform plan and apply | `Aston.S` initiated the protected workflows. | Counterpart review is required for follow-up changes.               | Agroasys administrator | `agroasys-cotsel-terraform-apply/GitHubActions`             | Counterpart operator          | PARTIALLY VERIFIED                 |
| Cotsel PR `#748`                | Last pusher is recorded by GitHub.           | `AvitusI` approved head `44840a8f34c4838ec0b30ded584ba94b54694ba2`. | Agroasys administrator | Squash merged as `34251f874d5f983111b97827ca986ac8b1ce3d39` | Independent counterpart       | VERIFIED for implementation review |
| Cotsel PRs `#746` and `#749`    | Last pushers are recorded by GitHub.         | `AvitusI` is requested.                                             | Agroasys administrator | Not applied                                                 | Independent counterpart       | BLOCKED                            |
| Backend merge `#590`            | Repository author and administrator          | No counterpart acceptance is recorded here.                         | Agroasys administrator | GitHub merge workflow                                       | Counterpart release authority | PARTIALLY VERIFIED                 |
| Dash merge `#202`               | Repository author and administrator          | No counterpart acceptance is recorded here.                         | Agroasys administrator | GitHub merge workflow                                       | Counterpart release authority | PARTIALLY VERIFIED                 |

Administrator authority did not waive settlement or release acceptance.

## Terraform and infrastructure identity

| Field                          | Current evidence                                                    | Classification |
| ------------------------------ | ------------------------------------------------------------------- | -------------- |
| Cotsel root                    | `infra/terraform/staging-platform`                                  | VERIFIED       |
| State bucket                   | `agroasys-tfstate-655177116834`                                     | VERIFIED       |
| State key                      | `cotsel/staging-platform/terraform.tfstate`                         | VERIFIED       |
| State bucket region            | `eu-north-1`                                                        | VERIFIED       |
| Workload region                | `ap-south-1`                                                        | VERIFIED       |
| State version ID               | `_2uIORjYJYV68PpwV3uLQ0PJxvItNDJ8`                                  | VERIFIED       |
| State serial                   | `29`                                                                | VERIFIED       |
| State lineage                  | `e8ef49f4-e48e-9ee9-6a1b-0885633d264e`                              | VERIFIED       |
| State update                   | `2026-08-25T10:23:25Z`                                              | VERIFIED       |
| Reviewed plan run              | GitHub Actions run `32835524840`                                    | VERIFIED       |
| Exact-plan apply run           | GitHub Actions run `32835741862`                                    | VERIFIED       |
| Ricardian-only plan run        | GitHub Actions run `32851990204`; not applied; superseded by `#749` | STALE / LEGACY |
| Ricardian rollout plan version | `StRkE7Iro3fU1Uhpxwy5WXCwmLYDCsQJ`                                  | VERIFIED       |
| Ricardian rollout plan SHA-256 | `88fd16fc344c577677e3c813070f48fc68a84393ee6a54f86342e6bc2e5e1eb0`  | VERIFIED       |

The local `agroasys` AWS profile defaults to `eu-north-1`. Classify this as `MISCONFIGURED` for workload commands.

Use an explicit `--region ap-south-1` for every workload query. Do not change the shared profile without a consumer check.

The superseded Ricardian-only plan has `0` additions, `1` in-place change, and `0` destroys.

Its only change is `cotsel-staging-ricardian.desired_count: 0 -> 1`. It was not
applied and must not be applied because `#749` changes the same task-definition
surface. Let the saved-plan artifact expire.

After `#749` merges, create one new combined protected plan. It may include the
reviewed read-only-root-filesystem changes and Ricardian desired count `0 -> 1`.
It must keep Treasury at zero. Stop on any unrelated IAM, secret, database,
network, image, contract, RPC, or destructive change. A different actor must
dispatch the reviewed combined plan's apply.

A new no-change refresh plan remains required after the rollout. Classify drift closure as `PARTIALLY VERIFIED`.

## AWS runtime identity

### Cotsel services

| Service        | Desired/running | Task definition              | Running task                                                                               | Image identity                                                                             | Classification     |
| -------------- | --------------- | ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------ |
| Gateway bundle | `1/1`           | `cotsel-staging-gateway:21`  | `arn:aws:ecs:ap-south-1:655177116834:task/cotsel-staging/745dc3e61de84da6867390b60ec701d8` | See the digest list below.                                                                 | VERIFIED           |
| Ricardian      | `0/0`           | `cotsel-staging-ricardian:3` | None                                                                                       | `cotsel/ricardian@sha256:494a87bc42ea39ee63884fce65e138f0d1b9d9d5a5860b0f0c49a6d9e4eb200f` | PARTIALLY VERIFIED |
| Treasury       | `0/0`           | `cotsel-staging-treasury:3`  | None                                                                                       | `cotsel/treasury@sha256:483b00c7468d7cfb0722e9c2436a4efd76cffa7807ca4057fb87f01e04bebab0`  | PARTIALLY VERIFIED |

All three services use private subnets. All three services disable public IP assignment.

The current gateway task runs these immutable images:

| Container          | Digest                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `auth`             | `sha256:dbb4018ac22dca342201127d3a334115464f8c2551f1df57b4561793162302e2` |
| `gateway`          | `sha256:a194ae744094f3cbf1bfa735e1d51913c24ffa2f8e8dce82a34ad3d0b61d87f5` |
| `indexer-graphql`  | `sha256:a3c9ef638dbb7a2e315982edb11abde5a071829b5683c405bde7cb8d2b67fd4d` |
| `indexer-pipeline` | `sha256:ea3317c328b238d369dc1996cf7c333ec2000f3e801a2ba610e106dfc7d854d4` |
| `oracle`           | `sha256:0130b71e0a78832f058c66ed995a2ccd9cc46b527ee59cd10a5f350888ce6d30` |
| `reconciliation`   | `sha256:4dfbf77f41b6bec6280733d40646919d51201ac00fa4556da2d34d5216640553` |

Release Images run `32757298513` produced the Cotsel image set from commit `6052ed389e885fce3711be0794c8df0df6fe6d95`.

### Backend services

The backend runtime is `MISCONFIGURED` because the API and workers use different historical images.

| Service group | Task definitions                                                   | Running task ARNs                                                                                                                                                                                      | Digest and source tag                                                                                                        |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| API           | `agroasys-staging-api:6`; desired/running `2/2`                    | `.../67a3eca984044fb59167d8b014baec65`; `.../f61cb72566c94740b34fafab615e00d4`                                                                                                                         | `sha256:11a588f2a0e4162c4cd5a7c333a78631854eaa5d9fe20000f6a72ab29a8e9580`; source `131292cf59061d46bb43adca54aa133155673c3d` |
| Workers       | Five task definitions at revision `:5`; desired/running `1/1` each | `.../48be2e45d6fe41c88e485f5a04ce846c`; `.../5918c189b0c44441ac6d9e95c3880e5c`; `.../6ca5c5c43480436992659a8ae2dc2100`; `.../8c22c3c012cd499291f9d319016b09a7`; `.../954dfcaa5f574c9196153b22e358f0dc` | `sha256:f46b8c88283b5c6db9d1b5b358932f2bb93cc8bf500d0369e52d0101311febd4`; source `95e79bc7e8dafdba06cc6f54976e0eaf1bdacab2` |

All backend services use private subnets. They disable public IP assignment.

Backend Release Image run `32849125763` produced this undeployed candidate:

`agroasys-backend@sha256:8184bd2a441bba273eb802d57078eaf0d4b7ef94317c540cb441ff5e128869cc`

The source commit is `b9e04ea3ac48105accc260f7b8c85ccb927fba1f`.

Do not describe this digest as deployed until the running task definitions use it.

## Database authority and entitlements

The active database is RDS PostgreSQL. It is not Aurora.

| Field                           | Evidence                                                           | Classification |
| ------------------------------- | ------------------------------------------------------------------ | -------------- |
| Instance                        | `agroasys-staging`                                                 | VERIFIED       |
| Endpoint identifier             | `agroasys-staging.cvwaew84syk7.ap-south-1.rds.amazonaws.com:5432`  | VERIFIED       |
| Placement                       | Multi-AZ                                                           | VERIFIED       |
| Encryption                      | Enabled                                                            | VERIFIED       |
| Backup retention                | Seven days                                                         | VERIFIED       |
| Deletion protection             | Enabled                                                            | VERIFIED       |
| Ricardian migration-tree digest | `ae3463e8a7287994967a6293839fc6e71ee6124fb734417083bf84b534ea5b3e` | VERIFIED       |
| Treasury migration-tree digest  | `bd387f790eb513f1b7ea3843cd761a1692563793ac9ff90c77f09390b1205993` | VERIFIED       |

The bootstrap task used `cotsel-staging-database-bootstrap:3`. CloudTrail records no task overrides.

The Ricardian migration task used `cotsel-staging-ricardian-migrate:1`. It completed successfully.

No Treasury migration task has run. This is correct while Treasury remains stopped.

The fresh entitlement verifier used `cotsel-staging-database-entitlement-verification:1`.

Verifier task ARN:

`arn:aws:ecs:ap-south-1:655177116834:task/cotsel-staging/9863ffb8ce5f4c9ab7120ca4ebfd9fab`

CloudTrail records these properties:

- request time: `2026-08-25T12:55:39Z`;
- task overrides: `null`;
- public IP: `DISABLED`;
- private subnets: `subnet-09e9de9b735d9579a` and `subnet-02b28a68bfc9c12b9`;
- exit code: `0`; and
- log result: database entitlement verification passed.

The verifier proves migration/runtime separation and cross-database denial. Classify the entitlement boundary as `VERIFIED`.

The verifier does not prove a canonical live database schema hash. Classify the live schema-hash requirement as `PARTIALLY VERIFIED`.

## Secret and IAM identifiers

The ledger records names only. It does not record secret values.

Required service-auth secrets:

- `/agroasys/staging/cotsel/gateway-settlement-ingress`
- `/agroasys/staging/cotsel/gateway-settlement-callback`
- `/agroasys/staging/cotsel/gateway-to-ricardian-auth`
- `/agroasys/staging/cotsel/gateway-to-treasury-auth`

Required RPC secrets:

- `/agroasys/staging/cotsel/rpc-base-sepolia-primary`
- `/agroasys/staging/cotsel/rpc-base-sepolia-fallback`

Required service database secrets:

- `/agroasys/staging/cotsel/database/ricardian/migration`
- `/agroasys/staging/cotsel/database/ricardian/runtime`
- `/agroasys/staging/cotsel/database/treasury/migration`
- `/agroasys/staging/cotsel/database/treasury/runtime`

The long-running Ricardian and Treasury task roles have no secret-read policy.

Their execution roles can read only their required runtime and service-auth secrets.

Their migration execution roles can read only their own migration secrets.

Classify this live IAM separation as `VERIFIED`.

Live credential-value distinction and both signed directions remain `PARTIALLY VERIFIED` until Phase 6.

## Network, DNS, and origins

| Name or resource              | Current target                                                            | Purpose                              | Classification         |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------ | ---------------------- |
| `cotsel.sys.agroasys.com`     | CloudFront `E2RCCBSGZN8VKE`; `d16q72wnefquce.cloudfront.net`              | AWS Cotsel system/API edge           | VERIFIED               |
| `cotsel-staging-gateway` ALB  | `internal-cotsel-staging-gateway-1560954281.ap-south-1.elb.amazonaws.com` | Private Cotsel origin                | VERIFIED               |
| `cotsel.agroasys.com`         | GCP address `34.10.181.103`                                               | Current dashboard lane               | VERIFIED               |
| `cotsel.staging.agroasys.com` | No DNS record                                                             | No active canonical purpose          | STALE / LEGACY         |
| `ops.agroasys.com`            | GCP address `34.172.10.248`                                               | Existing platform/session dependency | INTENTIONALLY RETAINED |

No AWS Cotsel dashboard CloudFront distribution exists. Classify Phase 5 dashboard infrastructure as `NOT IMPLEMENTED`.

Cloudflare proxy, TLS, WAF, and origin-rule configuration need a direct control-plane query. Classify those properties as `BLOCKED` in this revision.

## Base Sepolia identities

Chain ID: `84532` / `0x14a34`.

Canonical Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

No contract has independent acceptance. The accepted-contract field is therefore `BLOCKED`.

### Active runtime candidate

| Field                  | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| Address                | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`                         |
| Deployment transaction | `0xb6af9e63a64fbbdc3f3294bf35c749c59b77a09a12b9f8df3dd4b90b3cfad5df` |
| Deployment block       | `45807259`                                                           |
| Claimed source         | `1b3c64051e3fa29f8f148b24f5ec2537964407d1`                           |
| Compiler               | Solidity `0.8.34`; IR; optimizer `200`; EVM `paris`                  |
| ABI hash               | `572c473d519c81c67d0fe6fa3174439aca53d17f45b9b8438c196bcf916aaed1`   |
| Creation-bytecode hash | `b3429757821ff6089d330e2c97f69c0fe8ee489d392cced82c689bb5b76b6909`   |
| Runtime-bytecode hash  | `60a861277ecc63e5b0b08001c8db174677c61d3fe00d82eb33e124d369ee41cc`   |
| Acceptance             | Absent                                                               |

Current Cotsel gateway, oracle, indexer, and reconciliation configuration uses this address and block.

Classify this deployment as `PARTIALLY VERIFIED`. It has provenance evidence but no acceptance decision.

### New clean-worktree candidate

PR `Cotsel#746` records a second deployment candidate.

| Field                            | Value                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| Address                          | `0x95021c0fD0C69BB5Cb991832476B646857632e5d`                         |
| Deployment transaction           | `0xe38c4dd37d2cdf465bb8c61a0801d5d63d0c228067f99e143f63d11e0afae5ca` |
| Deployment block                 | `45914609`                                                           |
| Source commit                    | `6052ed389e885fce3711be0794c8df0df6fe6d95`                           |
| Compiler                         | Solidity `0.8.34`; IR; optimizer `1`; EVM `paris`                    |
| ABI hash                         | `4384792054d99e2063cd133c62c22aea3916982d5d9c29d2c168217e6e552277`   |
| Creation-bytecode hash           | `3f0acaa9810bcaa1d64796333936c105fdc00ccc7aadc78a5f2108761f9cd0a8`   |
| Normalized runtime-bytecode hash | `9554685d6655a4cf70417ce40c754e039948b15720a9294f1e3ad435accd049f`   |
| Acceptance                       | Absent                                                               |

The AWS runtime does not use this candidate. Classify address convergence as `NOT IMPLEMENTED` for this candidate.

The RPC primary secret passed the latest managed check. The fallback `AWSCURRENT` version returned `403`.

The fallback `AWSPREVIOUS` version passed. Do not rotate or expose either value through this ledger.

Classify dual-provider readiness as `MISCONFIGURED` until the approved rotation and failover exercise completes.

## AWS security and operations controls

| Control           | Current evidence                                                                           | Classification     |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------ |
| CloudTrail        | `agroasys-security`; multi-region; validation enabled; logging to S3 and CloudWatch        | VERIFIED           |
| GuardDuty         | Detector `3e5dad6f8d8545eaa47672e8d5e5c3db`; enabled                                       | VERIFIED           |
| Security Hub      | `arn:aws:securityhub:ap-south-1:655177116834:hub/default`                                  | VERIFIED           |
| AWS Config        | Recorder `agroasys-security`; continuous; all supported resources                          | VERIFIED           |
| AWS Backup        | Plan `agroasys-staging-daily`; ID `7dcfd448-5502-4962-924e-0b19ee2bb849`; 35-day retention | PARTIALLY VERIFIED |
| CloudWatch alarms | `33`; all have alarm actions                                                               | PARTIALLY VERIFIED |
| Operator topic    | `arn:aws:sns:ap-south-1:655177116834:agroasys-staging-operator-alerts`; zero subscriptions | MISCONFIGURED      |

The alarm actions do not prove operator delivery. Issue `Cotsel#672` tracks the required recipient confirmation.

## GCP inventory and disposition

No GCP resource is ready for deletion in this revision.

| Project and resource                                                        | Current state                                       | Consumer or purpose                            | Disposition            |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| `agroasys-1/server-1`                                                       | Running; `us-central1-f`; public IP `34.172.10.248` | Backend, operations, and session rollback lane | INTENTIONALLY RETAINED |
| `agroasys-1/instance-20260408-102022`                                       | Attached `45 GB` balanced disk                      | Stateful VM disk                               | INTENTIONALLY RETAINED |
| `agroasys-1/agroasys-precutover-20260824`                                   | Ready `45 GB` snapshot                              | Pre-cutover recovery                           | INTENTIONALLY RETAINED |
| `agroasys-1` daily snapshots from `2026-08-11` through `2026-08-24`         | Ready                                               | Historical recovery                            | INTENTIONALLY RETAINED |
| `agroasys-1` default compute service account                                | Enabled; log writer and metric writer only          | VM telemetry                                   | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2/cotsel-staging`                                         | Running; `us-central1-a`; public IP `34.10.181.103` | Historical Cotsel and dashboard rollback lane  | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2/cotsel-staging` disk                                    | Attached `50 GB` balanced disk                      | Stateful VM disk                               | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2/cotsel-precutover-20260824`                             | Ready `50 GB` snapshot                              | Pre-cutover recovery                           | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2` snapshots from `2026-04-02` through `2026-04-06`       | Ready                                               | Historical recovery                            | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2` daily snapshots from `2026-08-11` through `2026-08-24` | Ready                                               | Historical recovery                            | INTENTIONALLY RETAINED |
| `hale-yew-472207-r2` default compute service account                        | Enabled; log writer and metric writer only          | VM telemetry                                   | INTENTIONALLY RETAINED |

The accessible projects contain no listed GCS buckets. The Cotsel project has the Cloud SQL API disabled.

Do not enable a disabled GCP API only to complete an audit query. Record the access boundary instead.

Direct VM workload, traffic, webhook, and writer evidence needs a current remote inspection before decommission.

Classify GCP decommission readiness as `BLOCKED / UNKNOWN`.

## Claims versus evidence

| Claim                                                | Direct evidence                                                                                              | Classification     | Remaining gate                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| Cotsel AWS infrastructure is reproducible.           | Terraform root, state identity, reviewed plan, apply run, ECS definitions, and immutable digests are pinned. | PARTIALLY VERIFIED | Run a post-ledger no-change refresh plan.                                       |
| Database roles enforce the private-service boundary. | A fresh no-override verifier task exited successfully.                                                       | VERIFIED           | Repeat after any role or schema change.                                         |
| Ricardian is ready for runtime acceptance.           | Image, task definition, IAM, migration, database grants, and private network are pinned.                     | PARTIALLY VERIFIED | Merge `#749`, apply one combined plan, then run signed health and replay tests. |
| Treasury is ready for runtime acceptance.            | Image, task definition, IAM, grants, and private network are pinned.                                         | PARTIALLY VERIFIED | Run Treasury migration after Ricardian acceptance.                              |
| Backend runtime is current.                          | API and worker tasks use two older digests.                                                                  | MISCONFIGURED      | Deploy one reviewed digest to all intended services.                            |
| Cotsel-Dash runs through AWS.                        | No dashboard distribution exists; public dashboard DNS points to GCP.                                        | NOT IMPLEMENTED    | Complete Phase 5.                                                               |
| Both RPC providers are ready.                        | Primary passes; fallback `AWSCURRENT` returns `403`.                                                         | MISCONFIGURED      | Approve rotation and prove failover, recovery, and alarms.                      |
| A staging contract is accepted.                      | Two candidates exist; neither has an independent acceptance decision.                                        | BLOCKED            | Accept one candidate or deploy and accept a replacement.                        |
| All consumers use the accepted address.              | No accepted address exists.                                                                                  | NOT IMPLEMENTED    | Accept one candidate, then converge every consumer.                             |
| Operator alerts reach a person.                      | Alarms target an SNS topic with zero subscriptions.                                                          | MISCONFIGURED      | Confirm and test a real recipient.                                              |
| GCP is ready to decommission.                        | Both VMs and their state remain active and retained.                                                         | BLOCKED            | Complete AWS acceptance, traffic checks, backup checks, and approval.           |

## Current execution gate

Phase 1 is `PARTIALLY VERIFIED`. The live baseline is recorded, but Cloudflare control-plane evidence remains open.

Phase 2 is `PARTIALLY VERIFIED`. PR `#748` has exact-head approval. Other sensitive PRs remain blocked.

Phase 3 database entitlements are `VERIFIED`.

Phase 3 Ricardian rollout remains the next runtime gate. The prior Ricardian-only
plan is superseded. Complete `#749`, produce and review one combined plan, and use
counterpart apply. Validate the gateway before Ricardian.

Do not start Treasury before Ricardian passes its runtime and replay gates.

## Reproduction commands

Run all AWS workload commands with an explicit region.

```text
aws sts get-caller-identity --profile agroasys
aws ecs describe-services --profile agroasys --region ap-south-1 ...
aws ecs describe-tasks --profile agroasys --region ap-south-1 ...
aws cloudtrail lookup-events --profile agroasys --region ap-south-1 ...
aws rds describe-db-instances --profile agroasys --region ap-south-1
aws s3api head-object --profile agroasys --region eu-north-1 ...
gcloud compute instances list --project agroasys-1
gcloud compute instances list --project hale-yew-472207-r2
gh pr view <number> --repo <owner/repository> --json headRefOid,reviews,statusCheckRollup
```

Redact command output before attaching it to issues. Never attach raw Terraform state or secret values.
