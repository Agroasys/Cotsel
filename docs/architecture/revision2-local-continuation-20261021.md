# Consolidated Revision 2 local continuation

Audience: Cotsel, backend, QA, Finance, security, and operations reviewers.
Scope: local candidate from merged main `14a491c5`; no production activation or operating authority.
Documentation standard: Google Technical Writing.

The continuation retains all reviewed limiter, cleanup, dependency, and exact-byte HMAC corrections.
The paired funding bridge uses the existing authenticated create-trade route, workflow, managed executor,
nonce reservation, immutable transaction inventory, and local signer transport.
The lifecycle bridge remains a dormant, exact-bound test composition with unchanged public denials.
Both bridges retain request limiting and close their database, HTTP, and RPC resources.

The retained indexer bootstrap accepts its normal database as a default dependency.
The production entry point retains that default. The explicit local test executable composes the same mapping
with Subsquid's supported finalized-only database mode.
This aligns GraphQL projection and processor checkpoints at a finalized anchor.
Actual migration runners, non-superuser runtime roles, GraphQL reads, reconciliation runs, and UTC sessions
produce the financial-coverage evidence. The test adapter inserts no checkpoint, trade projection, or reconciliation run.

Completion writers store UTC explicitly in the existing timestamp column; readers do not require a particular session timezone.
PostgreSQL regressions use separate writer and reader sessions with regional zones, UTC aliases, and a different Node timezone.
Stale, future, contained, and newer-drift coverage remains unavailable.
Deploy the corrected writers before exposing financial coverage, and obtain a fresh clean run afterward.
Existing completion timestamps are not rewritten or backfilled.

No new execution endpoint, contract, financial policy, signature format, recipient, or public activation switch is added.
Mirrored local nodes and controlled managed signing do not prove independent providers or deployed custody.
The backend completion record describes financial assertions, process-death restrictions, and remaining acceptance gates.
