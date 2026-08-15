# Contract-cohort rollback

## Purpose

Use this procedure when a non-upgradeable escrow deployment must stop receiving new trades or when traffic must return to an accepted previous deployment. It does not move active funds between contracts. Each contract address remains authoritative for the trades and funds created there.

## Required record

Before execution, create an incident record with:

- incident reference and decision owner;
- current and rollback contract addresses, chain IDs, deployment blocks, ABI hashes, and bytecode hashes;
- application and indexer artifact digests;
- active trade count and USDC exposure for each contract;
- paused scopes, affected journeys, and known compatibility limits;
- named Protocol, Finance, Operations, and Release approvers.

Do not continue when an address, artifact, role, exposure value, or owner is unknown.

## Containment

1. Stop new trade intake at the gateway and user interface.
2. Pause the affected contract scope. Use the smallest scope that contains the incident. Record the transaction hash and incident reference.
3. Disable deployment promotion and configuration changes for the affected release.
4. Preserve gateway, indexer, Oracle, treasury, RPC, and contract logs.
5. Notify Finance and Operations. State that existing trades remain bound to their original contract.

## Inventory and decision

1. Export every active trade for the current and rollback addresses.
2. Reconcile contract balances, trade states, pending transactions, indexed events, and treasury records.
3. Classify each active trade as safe to continue, paused for investigation, or requiring a governed forward fix.
4. Confirm that the rollback application still supports the ABI and events for every active cohort.
5. Choose one action:
   - route new trades to the accepted previous address;
   - keep intake stopped and forward-fix the current release; or
   - operate both addresses during a time-bounded compatibility window.

A configuration rollback must never silently reassign an existing trade to another contract.

## Execution

1. Pin the selected application, gateway, Oracle, SDK, and indexer artifacts by immutable digest.
2. Configure the new-trade address only after two-person review of the chain, address, ABI, bytecode, USDC token, and role attestation.
3. Keep event ingestion and reconciliation active for every address with non-zero exposure or an unfinished trade.
4. Deploy the compatible application artifacts through the protected release path.
5. Run zero-value probes for contract reads, authorization signing, gateway simulation, event ingestion, and reconciliation.
6. Re-enable new intake only after the decision owner and required approvers accept the evidence.

## Recovery and exit

Do not close the incident until:

- all active cohorts are visible and reconciled;
- no pending transaction has an unknown outcome;
- each contract balance equals its recorded liabilities;
- the configured new-trade address matches the accepted release manifest;
- monitoring covers every address that still has exposure;
- the unpause proposal identifies the incident and has the required quorum;
- Finance and Operations approve resumption; and
- the retained evidence includes queries, manifests, transaction hashes, approvals, timestamps, and residual risk.

Retire an old address from consumers only after its active trade count and financial exposure are both zero and the evidence-retention period is approved.

## Drill ownership

WP-1 owns this design and its automated contract/configuration tests. WP-8 owns the production-like incident and rollback drill. WP-11 repeats the relevant path against the exact controlled-pilot release candidate. A written procedure is not evidence that either live drill passed.
