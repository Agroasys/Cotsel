# Base Sepolia deployment provenance audit — 2026-08-23

Status: independently reproduced deployment evidence; issue #639 still requires
an explicit independent reviewer decision before this address becomes accepted
staging truth.

## Scope and safety

This packet verifies the non-secret provenance of the Base Sepolia deployment
currently configured in AWS staging. It does not contain private keys,
authenticated RPC URLs, API tokens, HMAC material, signed headers, or sensitive
payloads.

The audit used:

- a detached clean worktree at the claimed source commit;
- the managed primary RPC retrieved from AWS Secrets Manager without printing
  the endpoint;
- the explorer API key retrieved from AWS Secrets Manager without printing it;
- direct Base Sepolia JSON-RPC responses;
- direct reads from the deployed contract; and
- the Etherscan v2 source-code API for chain `84532`.

## Claimed deployment

| Field                  | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| Network                | Base Sepolia                                                         |
| Chain ID               | `84532` / `0x14a34`                                                  |
| Contract               | `0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd`                         |
| Deployment transaction | `0xb6af9e63a64fbbdc3f3294bf35c749c59b77a09a12b9f8df3dd4b90b3cfad5df` |
| Deployment block       | `45807259`                                                           |
| Claimed source commit  | `1b3c64051e3fa29f8f148b24f5ec2537964407d1`                           |
| Compiler               | Solidity `0.8.34`, EVM `paris`, via IR                               |
| Optimizer              | enabled, `200` runs                                                  |

The canonical repository bundle is:

`contracts/reports/deploy/base-sepolia/agroasysescrow-deploy.json`

## Clean-room artifact reproduction

The exact claimed source commit was checked out into a detached temporary
worktree. Dependencies were installed with the frozen lockfile and the contract
workspace was force-compiled.

Commands:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm --filter contracts run compile
```

Reproduced hashes:

| Artifact                       | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| ABI JSON                       | `572c473d519c81c67d0fe6fa3174439aca53d17f45b9b8438c196bcf916aaed1` |
| Creation bytecode              | `b3429757821ff6089d330e2c97f69c0fe8ee489d392cced82c689bb5b76b6909` |
| Live deployed runtime bytecode | `60a861277ecc63e5b0b08001c8db174677c61d3fe00d82eb33e124d369ee41cc` |

The live runtime bytecode is `24,417` bytes.

The audit rebuilt the full deployment transaction input from the reproduced
creation bytecode and the recorded constructor arguments. It exactly matched
the input of the on-chain deployment transaction. This proves the transaction
was created from the claimed artifact and arguments; it is stronger than a
source-only or explorer-only comparison.

## Chain and receipt proof

Direct JSON-RPC checks returned:

- chain ID: `0x14a34`;
- receipt status: `0x1`;
- receipt block: `45807259`;
- receipt contract address: the claimed contract address;
- transaction `to`: `null`, confirming contract creation; and
- non-empty runtime bytecode at the claimed address.

The deployment transaction sender was:

`0xB0A1d8f64E2451165a93A6F99dD0d0Fb5d5D8806`

The public address derived inside the audit process from the approved AWS
deployment-wallet secret matched that sender. The secret value was not printed
or recorded.

Deployment-wallet secret reference:

`arn:aws:secretsmanager:ap-south-1:655177116834:secret:/agroasys/staging/base-sepolia/wallet-deployer-zbVCrr`

## Constructor and post-deployment state

| Role or parameter        | Verified value                               |
| ------------------------ | -------------------------------------------- |
| USDC                     | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Oracle                   | `0x440b6efe3f4E0A59A9F199f97C9E4cd9368A178B` |
| Treasury                 | `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc` |
| Treasury payout receiver | `0xc6d7c73f5a23B6b681e0fd95F30A1f38A64BE4bc` |
| Relayer                  | `0xE06E388BaEcFD9FcffD4890ddA552C4245c3aB2b` |
| Admin 1                  | `0x0817fe4A674a57af87E39d0CD341b2b5F0158599` |
| Admin 2                  | `0xcB1296C7149289CF1Bd0B84ce6D8c0F608E041cD` |
| Admin 3                  | `0x13F9507b51A883B1302B555F9530C0F2d1b5bB8f` |
| Required approvals       | `2`                                          |

Live read results:

- the three administrators are active;
- the relayer is allowed;
- the oracle is active;
- contract pause is false; and
- claims pause is false.

## Explorer source proof

The Etherscan v2 API for chain `84532` reported:

- source published: yes;
- contract name: `AgroasysEscrow`;
- compiler: `v0.8.34+commit.80d5c536`;
- optimization enabled: yes;
- optimizer runs: `200`;
- EVM version: `paris`; and
- proxy: no.

Explorer URL:

`https://sepolia.basescan.org/address/0xB594Cd561F28daBD771f9b358CF2bc731d14EDBd#code`

## Current runtime relationship

AWS ECS staging currently uses this address and deployment block across the
gateway, oracle, reconciliation, and indexer pipeline. Current live-runtime and
managed-RPC evidence is recorded separately in:

`docs/readiness/cotsel-forensic-completion-audit-2026-08-22.md`, under the
`2026-08-23 live promotion and forced-failover addendum` heading.

Terraform reconciliation for the six-container runtime is tracked by PR #724.
Until that reviewed IaC plan is merged, applied through the protected workflow,
and checked against the resulting task definition, AWS runtime ownership remains
partially verified rather than reproducible.

## Acceptance boundary

This packet proves deployment provenance and current on-chain configuration. It
does not supply the independent acceptance decision required by issue #639.
The deploy script at the claimed source commit did not yet record or enforce the
current `worktreeClean`, full compiler-input/source-digest, normalized-bytecode,
and role-attestation fields. This audit independently reproduced the artifact,
transaction input, live bytecode, explorer metadata, and live roles, but it
cannot retroactively prove that the operator's working tree was clean at the
moment of broadcast. The current protocol-health validator therefore correctly
classifies the original bundle as legacy/incomplete rather than silently
backfilling that fact.

The reviewer must compare the source, build, transaction, explorer source,
roles, runtime convergence, indexer/reconciliation evidence, and then explicitly
return either:

```text
ACCEPTED
```

or:

```text
REJECTED — <reasons>
```

Until that decision is recorded, this is the current staging deployment
candidate, not accepted staging truth.
