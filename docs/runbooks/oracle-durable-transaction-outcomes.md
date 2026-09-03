# Oracle durable transaction outcomes

## Purpose

Oracle settlement mutations use one durable transaction identity before broadcast.

The Oracle database stores the identity and outcome state. It does not store signed transaction bytes.

## Required state sequence

Each trigger has one transaction outcome record.

The normal sequence is:

1. `broadcast_pending`
2. `confirmation_pending`
3. Indexer or on-chain confirmation

An uncertain provider response uses `broadcast_unknown`.

A reverted receipt uses `reverted`.

The trigger status mirrors these states as `BROADCAST_PENDING`, `BROADCAST_UNKNOWN`, `SUBMITTED`, or `TERMINAL_FAILURE`.

## Broadcast rule

Oracle persists the transaction hash, chain, signer, nonce, destination, calldata hash, fee fields, and intent hash before broadcast.

The provider may be called once for that persisted identity.

The Oracle retry loop never retries a broadcast-unknown outcome.

The response returns a reconciliation-pending result when the provider response is ambiguous.

## Recovery rule

The outcome worker checks the original hash after process restart.

It checks a receipt first, then a pending transaction, then signer nonce evidence.

It never constructs or broadcasts a replacement transaction.

A missing hash remains visible as `broadcast_unknown`.

An advanced signer nonce records an unknown outcome and blocks automatic settlement retry.

Operators must reconcile the original hash before any separately approved action.

## Evidence requirements

Record the candidate commit, image digest, task definition, task ARN, chain ID, contract, provider identity, trigger key, transaction hash, and recovery result.

Do not record signed transaction bytes, private keys, authenticated RPC URLs, or raw credentials.

## Database proof

Run the proof against an explicitly named test database:

```bash
ORACLE_OUTCOME_PROOF_DATABASE_URL=postgresql://.../cotsel_oracle_wp2_test \
  pnpm --filter oracle test:transaction-outcome-db
```

The proof verifies the atomic `BROADCAST_PENDING` to `BROADCAST_UNKNOWN` to `SUBMITTED` transitions.
