# Managed signer intent binding

## Status and authority

This document defines the Cotsel side of the WP-2 managed-signer protocol. It is
an externally visible protocol decision and requires signer-platform review
before staging deployment. It does not authorize a release, signer, wallet, or
contract.

Gateway and Oracle clients fail closed until the signer platform implements this
contract. A legacy response containing only signedTransaction is incompatible
and must never be treated as accepted evidence.

## Transport and authentication

- Managed custody requires HTTPS.
- Gateway and Oracle require their own authenticated signer API key.
- Credentials remain in the approved secret store and are never logged or
  included in evidence.
- A signer API key identifies a service. It does not grant operator, treasury,
  governance, or contract-admin authority.

## Request contract

Each signing request contains:

- custodyMode: kms or mpc;
- operation: the explicit approved Cotsel operation;
- requestId: a new opaque one-time identifier, 1 to 128 characters;
- intentHash: the canonical transaction-intent hash;
- signerAddress: the exact expected signer address; and
- transaction: the exact transaction fields approved by Cotsel.

The canonical intent is serialized as a JSON object in this exact property
order:

1. requestId
2. checksum-normalized signerAddress
3. numeric chainId
4. checksum-normalized to
5. lowercase hex data
6. canonical decimal value
7. numeric nonce
8. canonical decimal gasLimit
9. numeric type
10. EIP-1559 fee fields, or the legacy gas-price field

For type 2 transactions, the final fields are maxFeePerGasWei and
maxPriorityFeePerGasWei. For type 0 transactions, the final field is
gasPriceWei. The intent hash is the keccak256 hash of the UTF-8 encoded
JSON.stringify output of the canonical intent.

The signer must independently canonicalize the request, verify intentHash,
permit only the requested operation and signer, atomically consume requestId,
and reject a duplicate request ID. It must not silently rewrite transaction
fields.

## Response contract

An accepted response contains exactly the binding information required by the
client:

- requestId: equal to the request;
- intentHash: equal to the locally calculated intent hash;
- signerAddress: equal to the expected signer; and
- signedTransaction: a complete signed EVM transaction.

Before broadcast, Cotsel parses the signed transaction, recovers its signer, and
compares:

- signer;
- recipient;
- chain ID;
- nonce;
- value;
- calldata;
- gas limit;
- transaction type;
- access list;
- max fee;
- priority fee; and
- legacy gas price.

Any mismatch rejects the response before RPC broadcast. Deterministic signer
rejection is not an RPC failure and must not trigger provider failover.

## Durable evidence

Gateway and Oracle append privacy-safe records before broadcast. Records contain
the one-time request ID, approved intent hash, signed transaction hash when
available, signer address, nonce, transaction type, outcome, failure reason, and
service correlation identifiers.

Raw signed transactions, credentials, authenticated URLs, private keys, request
bodies, and customer data are excluded. Runtime roles have SELECT and INSERT
only; they cannot update or delete signer-validation evidence.

Rejected responses also emit the structured event:

Managed signer transaction rejected before broadcast

WP-8 owns the metric filter, actionable alarm, monitored destination, retention,
and tested notification delivery for this event.

## Rollout sequence

1. Signer-platform reviewer accepts this request/response contract.
2. Signer platform deploys request-ID consumption, intent verification, and the
   bound response fields.
3. Compatibility probes prove Gateway and Oracle requests receive bound
   responses without broadcasting.
4. Database migrations are applied by the migration identity.
5. Gateway and Oracle images are deployed by immutable digest.
6. Positive and every field-mutation test run against staging.
7. A controlled mismatch proves durable evidence, alert delivery, no broadcast,
   credential revocation, scoped request review, rotation, and independently
   approved reauthorization.

Do not deploy the strict clients before step 2. Do not present local mocks as
signer-platform compatibility evidence.

## Containment and recovery

On any mismatch:

1. keep the transaction unbroadcast;
2. pause new managed-signer commands for the affected signer;
3. revoke the affected service credential through the approved secret process;
4. identify requests by request ID, intent hash, signed transaction hash, signer,
   operation, and time window;
5. reconcile the signer audit, RPC, chain, Gateway, Oracle, indexer, and
   settlement records;
6. rotate credentials without deleting historical evidence;
7. require signer-platform and Security approval before reauthorization; and
8. resume only after a new compatibility probe and controlled negative test.

A broadcast-unknown transaction is handled by the WP-2 durable transaction
outcome procedure. It must not be treated as a signer mismatch or blindly
rebroadcast.

## Rollback

The signer platform may continue returning the additional binding fields if a
Cotsel application rollback is required. The audit tables remain in place.
Application rollback uses the preceding immutable image only when it remains
compatible with the signer response and does not weaken an active containment
decision. Database evidence is never rolled back or deleted.
