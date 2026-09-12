# Gateway Governance Signer Custody

> [ADR-0411](../adr/adr-0411-human-governance-direct-wallet-signing.md)
> is the authority for human privileged governance. The gateway prepares and
> verifies transactions. A named human custodian signs and broadcasts with a
> dedicated hardware wallet.

## Purpose and scope

Operate the non-custodial governance prepare, hardware-wallet broadcast,
confirmation, and monitoring flow without placing administrator key material in
Cotsel, AWS, GitHub, or a backend workload.

## Current implementation status

**IMPLEMENTED IN SOURCE / NOT DEPLOYMENT-ACCEPTED.** The repository contains the
versioned signer register, direct-sign action store, prepare routes, confirm
route, independent transaction verification, and finality monitor. It contains
no governance queue, executor, server signer, KMS signing call, or replay path.

Keep governance mutations disabled until all of these conditions are true:

- the reviewed auth and gateway migrations are applied;
- the exact release is deployed;
- three named independent administrator custodians are registered;
- the dashboard uses the matching OpenAPI contract;
- two different registered administrators complete a witnessed rehearsal; and
- the release owner and security reviewer accept the evidence.

Source availability alone does not authorize a staging, pilot, or mainnet
governance transaction.

### Human administrator custody

For the controlled pilot and production, the direct-sign administrator boundary
is mandatory:

- the contract uses exactly three distinct approved administrator addresses with
  two required approvals;
- each administrator address is generated and held on a dedicated hardware
  wallet with a different authorized human custodian and no shared seed or
  recovery material;
- compatible browser wallet software may transport the prepared transaction,
  but the hardware device must display and physically approve the signature;
- no administrator key may be created in AWS KMS, stored in a backend secret,
  exposed to a workload, or made available to a delegated executor;
- the approved signer register binds each address to its authorized custodian
  without storing seed phrases, PINs, recovery material, device serial numbers,
  or personal location data; and
- before release acceptance, two different administrator hardware wallets
  complete a witnessed prepare-to-confirm governance rehearsal against the exact
  release candidate.

An EVM address does not prove hardware-wallet provenance. Contract and gateway
checks enforce signer identity and quorum; controlled provisioning, witnessed
rehearsal evidence, and custody attestations enforce the physical-device
boundary. A future change to delegated or managed administrator custody requires
a superseding architecture decision and reopens the affected release gate.

Privileged-path boundary:

- governance, treasury sweeps, and payout-receiver changes use only the
  registered hardware-wallet flow;
- buyer-facing account abstraction, paymaster support, or sponsored-gas experiments must not be reused for privileged actions
- privileged flows require explicit signer identity, approval evidence, and audit records for every execution step

Automation-governance source of truth:

- `docs/runbooks/programmability-governance.md`

## Authority separation

The five manual custody authorities are separate:

- administrator 1, administrator 2, and administrator 3 each use a different
  hardware wallet and named custodian;
- treasury uses a fourth hardware wallet and has no KMS permission; and
- the deployer uses a fifth hardware wallet and is retired and unfunded after
  deployment evidence is complete.

Oracle and gasless relayer use two different non-exportable KMS keys and task
roles. They are not administrator, treasury, or deployer authorities. The
gateway and auth services have no permission to sign with either key.

## Signer-register procedure

Each active record must contain the exact wallet address, account, action class,
environment, custodian name, approving authority, approval time, approval
ticket, and active or revoked state. Wildcard environments are forbidden.

1. Verify the address on the hardware-device display with the named custodian.
2. Verify the account is an active durable administrator profile.
3. Record custody and recovery evidence in the approval ticket. Do not record a
   seed phrase, private key, PIN, device serial number, or location.
4. Provision the binding through `POST /api/auth/v1/admin/signers/provision`.
5. Read it back through `GET /api/auth/v1/admin/signers?active=true`.
6. Resolve a fresh session and verify it contains only the exact active binding.

Revoke through `POST /api/auth/v1/admin/signers/revoke`. Revocation is retained
as immutable audit evidence; it is not deleted. A replacement wallet requires a
new approval and binding.

## Governance execution procedure

1. Confirm gateway mutations are enabled only for the approved evidence window.
2. Resolve a fresh administrator session and verify its `governance:write`
   capability and exact `governance` signer binding for the environment.
3. Call the action-specific `/governance/.../prepare` route with a unique
   idempotency key, the registered `signerWallet`, and audit reason, ticket, and
   evidence links.
4. Review the returned chain, contract, signer, method, arguments, calldata,
   value, nonce, expiry, audit reference, and prepared-payload hash.
5. Stop if the connected wallet or hardware-device address differs from the
   returned signer.
6. Approve the exact transaction on the hardware-device display and broadcast
   through the connected wallet. The gateway does not sign or broadcast it.
7. Submit the transaction hash to
   `POST /governance/actions/{actionId}/confirm` with the same registered signer.
8. If the action is `broadcast_pending_verification`, do not resubmit with a new
   hash. Allow the gateway monitor to resolve the existing hash.
9. Close the action only after the status and monitoring state show `executed`
   and `finalized`, or record the explicit `stale`, `reverted`, or `failed`
   outcome.

For quorum actions, a different registered administrator repeats the applicable
prepare, device review, broadcast, and confirm steps. Do not reuse a wallet,
seed, session binding, or transaction hash.

## Stop conditions

Stop without signing when:

- the signer binding is missing, revoked, for another environment, or for
  another action class;
- the connected or device-displayed wallet differs from `signerWallet`;
- any chain, contract, method, argument, calldata, value, nonce, expiry, or audit
  reference differs from the reviewed intent;
- the prepared action expired;
- the transaction hash is already attached to another action;
- confirmation reports a mismatch or the monitor reports stale or reverted; or
- any workload can access an administrator, treasury, or deployer private key.

Do not use a raw contract call, direct database write, queue, executor, replay
worker, CLI signer, KMS key, buyer wallet, paymaster, or old checkout as a
fallback.

## Custody recovery and compromise

For loss, compromise, offboarding, or address mismatch:

1. Disable gateway mutations.
2. Revoke the signer-register binding.
3. Preserve the last confirmed address, action, and transaction evidence.
4. Follow the approved hardware-wallet recovery procedure with the custody and
   security authorities. Do not enter recovery material into a workstation,
   Cotsel, AWS, GitHub, or an incident ticket.
5. Register a replacement only after the on-chain administrator change has a
   separately reviewed and supported procedure.
6. Repeat the two-admin rehearsal before re-enabling mutations.

## Evidence and audit minimums

Retain the signer binding and approval ticket, `actionId`, `intentKey`, request
and correlation IDs, prepared-payload hash, exact unsigned transaction, signer
address, transaction hash, block number, receipt status, confirmation depth,
final monitoring state, and reviewer identities.

Store the packet using
`docs/runbooks/operator-audit-evidence-template.md`, and use
`docs/incidents/incident-evidence-template.md` when incident-driven.

## Separate gasless relayer boundary

The refill procedure below applies only to the gasless settlement relayer. It
does not authorize governance signing. Staging and production relayer custody
use the dedicated non-exportable relayer KMS key; administrator, treasury,
deployer, Oracle, auth, and gateway roles must not receive `kms:Sign` for it.

## Gasless relayer wallet refill / top-up procedure

### When to refill

Refill the gasless relayer wallet when any of the following conditions are observed:

- The `gasless_low_executor_balance` alert fires (severity: critical). This means the executor balance has dropped to or below `GATEWAY_GASLESS_LOW_BALANCE_ALERT_WEI`.
- The readiness endpoint (`GET /api/dashboard-gateway/v1/operations/gasless-relayer/readiness`) returns `state: degraded` or `state: blocked`.
- The `gasless_executor_balance_below_capacity_policy` alert is present, indicating the observed balance does not cover the burst-hour capacity policy (`requiredBurstHourBalanceWei`).
- A proactive balance check shows the relayer is trending below the safety margin for the next 24-48 hours of expected transaction volume.

### How to check the current balance

1. **Readiness endpoint** (preferred):

   ```bash
   curl -s https://<gateway-host>/api/dashboard-gateway/v1/operations/gasless-relayer/readiness \
     | jq '.executorBalanceWei, .state, .alerts'
   ```

   The `executorBalanceWei` field shows the last observed balance. The `state` field will be `ready`, `degraded`, or `blocked`. The `alerts` array contains any active threshold violations.

2. **On-chain balance check**:

   ```bash
   cast balance <executor-address> --rpc-url <rpc-url>
   ```

   Use the relayer address shown in the readiness payload under `controls` or from the managed signer address endpoint. The API retains the legacy `executorBalanceWei` field name for compatibility.

3. **Capacity policy check**: Compare the balance against `capacityPolicy.requiredBurstHourBalanceWei` in the readiness response. If the balance is below that value and `capacityFailClosed` is true, the relayer will reject new broadcasts.

### How to fund the relayer

1. Identify the approved funding source address. Only pre-approved treasury or operations wallets may send ETH to the relayer. The approved funding addresses must be documented in the team's access control records.

2. Transfer native ETH through the approved treasury multisig or managed
   operations signer. Verify the displayed destination, chain ID, and amount
   before approval. Do not place a private key in a command, shell history,
   environment file, ticket, or runbook evidence.

3. Record the following for the refill:
   - funding source address
   - relayer destination address
   - amount transferred (in ETH and wei)
   - transaction hash
   - block number
   - operator identity
   - linked alert or incident ticket
   - timestamp

### How to verify recovery

1. Wait for the transfer to confirm on-chain (1 block confirmation minimum).

2. Re-check the readiness endpoint:

   ```bash
   curl -s https://<gateway-host>/api/dashboard-gateway/v1/operations/gasless-relayer/readiness \
     | jq '.executorBalanceWei, .state, .alerts'
   ```

   The `state` should return to `ready`. The `gasless_low_executor_balance` and `gasless_executor_balance_below_capacity_policy` alerts should no longer be present.

   Note: The readiness `executorBalanceWei` updates after the next broadcast or service restart. If the balance still shows stale data, trigger a lightweight health check or wait for the next scheduled broadcast.

3. Verify the next broadcast succeeds by monitoring the settlement execution event log or by checking that a pending gasless request completes without error.

4. Confirm no `blocked` or `degraded` state persists in the readiness snapshot.

### Safety constraints

- **Approved funding addresses only**: Only transfer ETH from pre-approved funding wallets (treasury, operations multisig, or designated refill wallet). Do not fund from personal wallets, exchange hot wallets, or unknown addresses.
- **Document the transfer hash**: Every refill must have its transaction hash recorded in the operator audit log alongside the alert or incident ticket that triggered the refill.
- **Verify before closing**: Do not close the alert or incident until the readiness endpoint confirms `state: ready` and at least one subsequent broadcast has succeeded.
- **Do not over-fund**: Transfer only the amount needed to restore the balance above `requiredBurstHourBalanceWei` plus a reasonable buffer (e.g., 2x the burst-hour requirement). Excess funds in the executor wallet increase exposure if the key is compromised.
- **Post-refill rotation check**: If the refill was triggered by an incident involving suspected key compromise, complete the refill first to restore service, then immediately follow the rotation procedure in the "Rotation and revocation" section above.

## References

- `docs/runbooks/dashboard-gateway-operations.md`
- `docs/runbooks/emergency-disable-unpause.md`
- `docs/runbooks/managed-signer-intent-binding.md`
- `docs/runbooks/production-readiness-checklist.md`
