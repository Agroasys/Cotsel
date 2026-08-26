# Base Sepolia current-main deployment evidence — 2026-08-24

Status: **DEPLOYED AND INDEPENDENTLY REPRODUCED; NOT ACCEPTED OR PROMOTED**.

Issue [#639](https://github.com/Agroasys/Cotsel/issues/639) remains the acceptance
owner. This packet supplies deployment and provenance evidence. It does not
self-authorize the address, change an AWS task definition, start an AWS service,
move public traffic, retire GCP, or authorize a controlled pilot.

## Immutable deployment identity

| Field                 | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| Source commit         | `6052ed389e885fce3711be0794c8df0df6fe6d95`                                             |
| Worktree at broadcast | clean, recorded as `worktreeClean: true`                                               |
| Network               | Base Sepolia                                                                           |
| Chain ID              | `84532` / `0x14a34`                                                                    |
| Contract              | `0x95021c0fD0C69BB5Cb991832476B646857632e5d`                                           |
| Transaction           | `0xe38c4dd37d2cdf465bb8c61a0801d5d63d0c228067f99e143f63d11e0afae5ca`                   |
| Deployment block      | `45914609`                                                                             |
| Receipt status        | `1`                                                                                    |
| Deployer              | `0xB0A1d8f64E2451165a93A6F99dD0d0Fb5d5D8806`                                           |
| Explorer              | `https://sepolia.basescan.org/address/0x95021c0fD0C69BB5Cb991832476B646857632e5d#code` |

Canonical machine-readable evidence:

`contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json`

## Pre-broadcast gates

The exact detached `main` commit was installed with the frozen lockfile and the
repository-supported Node 20, pnpm 10.34.4, Foundry 1.5.1, Solidity 0.8.34 and
Slither 0.11.6 toolchain.

| Gate                              | Result                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| ESLint                            | passed with zero warnings                                                            |
| TypeScript typecheck              | passed                                                                               |
| Hardhat                           | `125` passed, `0` failed                                                             |
| Foundry fuzz and invariants       | `22` passed, `0` failed; 200 fuzz runs per property and 700,000 invariant calls      |
| Coverage                          | 95.5% statements, 93.77% lines                                                       |
| Slither `--fail-high`             | passed; 0 High, 0 Medium, 22 Low, 56 Informational, 3 Optimization                   |
| Hardhat/Foundry source parity     | identical SHA-256 `e7654e678ad0081e57e01eea8907a6886cd82f73297d894d8cc567508bd21fe4` |
| Deployment gas estimate           | `5,661,096` gas; estimated maximum `0.000062272056` ETH                              |
| Deployer funding before broadcast | `0.006164468705898648` ETH, approximately 99 times the estimate                      |

Current source after PR #709 was independently reviewed and its source files did
not change between merge commit `9a952b73f49c8a8240ab2902af5908d5f69691ce`
and the deployed commit. The later deployment tooling changes were exercised by
the current-commit lint, typecheck, tests and live fail-closed deployment path.

## Provider checks

The primary Infura secret and independent fallback Alchemy secret remain in AWS
Secrets Manager under the Cotsel staging namespace. Authenticated URLs are not
recorded here.

Before broadcast, the primary returned chain `0x14a34`, current block data and
code for official Base Sepolia USDC. Alchemy intentionally rejected the audit
workstation because its IP was not on the provider allowlist. A fresh Fargate
probe then used the deployed private subnets, security groups and stable NAT
egress and returned chain `0x14a34`, current block `45914525` and USDC code.

After deployment, a second fresh Fargate probe independently returned chain
`0x14a34`, block `45914682` and `23,959` bytes at the new contract address. Both
diagnostic containers exited `0`; task-definition revisions
`cotsel-staging-rpc-fallback-forensic-probe:1` and `:2` were deregistered after
collection. The retained structured events are in CloudWatch log group
`/agroasys/cotsel/staging/indexer-pipeline`.

## Constructor and role matrix

| Role or parameter          | Verified value                               |
| -------------------------- | -------------------------------------------- |
| Official Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Oracle                     | `0x440b6efe3f4E0A59A9F199f97C9E4cd9368A178B` |
| Treasury                   | `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc` |
| Treasury payout receiver   | `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc` |
| Relayer                    | `0xE06E388BaEcFD9FcffD4890ddA552C4245c3aB2b` |
| Admin 1                    | `0x0817fe4A674a57af87E39d0CD341b2b5F0158599` |
| Admin 2                    | `0xcB1296C7149289CF1Bd0B84ce6D8c0F608E041cD` |
| Admin 3                    | `0x13F9507b51A883B1302B555F9530C0F2d1b5bB8f` |
| Required approvals         | `2`                                          |
| Governance epoch           | `1`                                          |

Direct post-deployment reads proved the relayer is allowed, the Oracle is
active, global pause is false and claims pause is false. The deployer has no
Oracle, treasury, relayer or administrator role.

## Independent provenance reconstruction

A separate read-only verifier did not trust the generated report. It loaded the
current artifact and build information, rebuilt the full creation input from the
bytecode and constructor arguments, and compared that input with the on-chain
transaction. The inputs matched exactly. The transaction had `to: null`, nonce
`1`, the recorded deployer, receipt status `1`, block `45914609` and the recorded
contract address.

| Artifact                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Compiler input           | `068206dfc9a1bc35ad36753789fe35fc79fba99f72edd21d3a7743289b7b4572` |
| ABI                      | `4384792054d99e2063cd133c62c22aea3916982d5d9c29d2c168217e6e552277` |
| Creation bytecode        | `3f0acaa9810bcaa1d64796333936c105fdc00ccc7aadc78a5f2108761f9cd0a8` |
| Live runtime bytecode    | `bde3a3b0ecaa507ee09f0dbb61957875b768da56f5386acb2fa30bc7f678b134` |
| Normalized local runtime | `9554685d6655a4cf70417ce40c754e039948b15720a9294f1e3ad435accd049f` |
| Normalized live runtime  | `9554685d6655a4cf70417ce40c754e039948b15720a9294f1e3ad435accd049f` |

The live runtime is `23,959` bytes and normalized immutable references match the
reviewed local artifact.

## Explorer verification

The canonical deployment required explorer verification and exited successfully
only after BaseScan accepted the source. A separate Etherscan v2 API query for
chain `84532` returned:

- source published: yes;
- contract name: `AgroasysEscrow`;
- compiler: `v0.8.34+commit.80d5c536`;
- optimizer: enabled, 1 run;
- EVM version: `paris`;
- proxy: no.

## Acceptance and promotion stop condition

The address is a deployment candidate until the acceptance owner explicitly
records `ACCEPTED` or `REJECTED — <reasons>` on #639 after reproducing the
evidence and completing the issue's required live-flow review. Until acceptance:

1. do not apply this address or block to the AWS platform Terraform;
2. do not start or promote gateway, Oracle, indexer or reconciliation against it;
3. do not describe it as accepted staging truth;
4. do not retire the historical AWS/GCP rollback lane because this contract exists.

After acceptance, the next gate is one reviewed Terraform plan that atomically
converges every active consumer on the accepted address and start block. Live
reads, indexer observation, reconciliation and the controlled staging flow must
then be collected from those exact deployed revisions.
