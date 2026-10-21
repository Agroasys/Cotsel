# Revision 2 local continuation

Audience: Cotsel, backend, QA, and independent reviewers.
Scope: local compatibility and evidence continuation. Public execution remains denied.

The local continuation merges target `ad9e0a81` into published candidate `8e6f506a`.
Six target commits update dependency versions and pinned workflow actions.
No application error implementation or contract source changes in that target range.

The unchanged escrow allocates trade ID zero first and uses `tradeCounter` as an exclusive bound.
Projection verification and retained reconciliation coverage now accept canonical zero.
The reconciler scans zero through `tradeCounter - 1` and rejects indexer IDs at or above the counter.
Its cursor remains nonnegative and identifies the next ID to compare.
Full sweeps continue to reset to zero; existing intermediate cursors incur a safe repeated comparison.
No migration checksum or historical run record is changed.

Retained financial coverage decodes legacy completion timestamps explicitly as UTC.
It compares timestamptz bounds without depending on the Node process timezone.
Non-UTC database sessions, future records, and stale records remain unavailable.
The PostgreSQL regression uses a deliberate past timestamp to avoid host/VM clock races.
Deployment acceptance must establish UTC sessions and historical timestamp provenance; this work changes no legacy timestamp data.

The existing test-only paired bridge optionally accepts two strictly loopback HTTP RPC URLs.
The actual owning custody adapter signs locally and broadcasts identical bytes to both Anvil nodes.
Funding verification reads their actual receipts.
The transport is available only through explicit fixture IPC, never production bootstrap or public activation.
Unknown fields, external hosts, credentials, URL paths, and unsupported transport schemes reject.
The public guards remain unconditional.

The backend continuation composes actual local contract execution, exact finalized input/recipient verification, and Finance commands.
It retains explicit controlled commercial/provider, projection-checkpoint, and managed-transport ports.
Local managed fixture signatures are not real KMS/MPC acceptance.
Mirrored loopback nodes are not independent operational providers.

The shared requirement matrix and approval prerequisites are in backend `docs/security/revision2-local-review-20261020.md`.
The local package `/Users/astonsteven/tmp/revision2-local-20261020` retains exact commits, commands, results, and log hashes.
No published branch, pull request, deployed service, provider setting, or participant record was changed.
