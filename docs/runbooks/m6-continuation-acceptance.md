# M6 continuation acceptance

Audience: maintainers, release owners and security reviewers. This record separates source implementation, local validation, release evidence and deployed acceptance for the four-issue continuation. It does not close the full M6 programme.

## Accepted decisions

| Decision | Required behavior                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1       | Normal quorum-controlled unpause remains available for a non-reconciliation pause only with fresh authenticated evidence of no reconciliation containment. Errors fail closed.                                                            |
| Q2       | Reconciliation recovery requires verified clean clearance for the exact trade and incident episode, newer than its divergence evidence.                                                                                                   |
| Q3       | Template activation uses durable preparation, independent approval and confirmation of the exact hash and predecessor. The off-chain adapter needs reviewer acceptance; direct two-person status changes do not replace this requirement. |
| Q4       | Dash independently verifies signed finding evidence against configured trusted public keys.                                                                                                                                               |
| Q5       | A freeze request has durable signed references and a recorded human decision and execution lifecycle. Reconciliation never signs governance transactions.                                                                                 |

## Implemented boundaries

| Review item | Implementation and local proof                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01–R03     | Signed chain/escrow context, incident snapshot, episode and per-run finding lineage. Shared recovery tests, real PostgreSQL lineage tests and gateway unpause route tests cover borrowed evidence, repeated divergence, stale/invalid proof and exact-trade clearance.                                                              |
| R04         | Dash snapshots replayable JSON and the idempotency key, coalesces recovery, checks operator/session revision, refuses identity switches and invalidates locally before logout awaits the network. API-level logout/retry regressions cover the race.                                                                                |
| R05–R06     | Template approval is bound to target hash and predecessor. The server rechecks the current activation allowlist at confirmation. Stale approval commits supersession before returning its refusal. Deferred SQL constraints require replacement and confirmation in one transaction; approval actors and timestamps stay immutable. |
| R07         | Signed opening runs atomically record immutable freeze requests. Gateway migration 020 stores human decisions with their audit rows; hardware-signing preparation binds the exact request and trade. Chain observations remain separate from approval.                                                                              |
| R08         | Node and WebCrypto verify the same public signed fixture. Connected adapter and real Chromium tests reject tampered evidence even when the server calls it verified. No private signing key ships in browser code or fixtures.                                                                                                      |
| R09–R10     | Migration 019 records a callback envelope while preserving callback HTTP bytes. Registered notification envelopes keep their event identity on deduplication. Invalid events are refused without a direct-delivery bypass.                                                                                                          |
| R11         | Break-glass audit records retain the operator's authentication assurance. Refresh preserves its original authentication time.                                                                                                                                                                                                       |
| R12–R13     | Containment and handoff sections load independently. Keyset pagination exposes a continuation cursor; Dash shows incomplete-list failures and keeps prior pages visible.                                                                                                                                                            |
| D1          | Old-image startup refusal is explicit. Database tests exercise current manifests and old-manifest refusal without changing the ledger. A reviewed, digest-bound compatibility-image or forward-repair deployment rehearsal remains a release prerequisite.                                                                          |
| D2 / R14    | Original issue criteria remain authoritative. Local green suites do not establish hosted CI, deployment, hardware signing, or programme completion.                                                                                                                                                                                 |

## Schema and migration rules

The candidate adds gateway 017–020, authentication assurance, notification outbox migrations, reconciliation signed manifests, incident lineage (010) and durable freeze requests (011). Inspect the exact version/checksum pairs in each service's `migrations.json`; filenames alone are not migration identities. The candidate-manifest and evidence-index fixtures must be rebound after every stack rebase.

The local source work amends migrations 017/018 only under the recorded premise that no persistent environment has applied them. Before release, inspect the actual environment ledger. If any checksum is already applied there, preserve it and express the repair as a new migration. Do not rewrite an applied ledger to match this candidate.

`shared-db/m6-forward-recovery.postgres.test.js` verifies the database startup contract on real PostgreSQL for auth, gateway and reconciliation: current migration/checksum validation passes twice, an older manifest fails, and the ledger remains intact. It does not establish full application-image compatibility, rollback timing or staging behavior.

## Release sequence and stop conditions

### Source acceptance

1. Review the exact backend and Dash candidate commits.
2. Split delivery into dependency-ordered PRs.
3. After each rebase, rebind the release-evidence fixtures.
4. Run each changed candidate's required checks.

Do not modify an approved remote PR without the agreed follow-up process.

### Infrastructure and backend deployment

1. Review the KMS policy and Terraform plan.
2. Apply the approved foundation plan.
3. Apply the approved platform plan.
4. Deploy Agroasys break-glass assurance.
5. Deploy Cotsel auth assurance.
6. Verify the real signed session exchange.
7. Verify the real break-glass grant exchange.
8. Deploy gateway step-up enforcement.
9. Migrate reconciliation with the approved migration task.
10. Deploy reconciliation with signing, lineage and freeze-request support.
11. Wait for a signed completed run.
12. Check internal evidence endpoint access restrictions.
13. Deploy treasury with the trusted public-key ring.
14. Test unsigned and invalid evidence refusal.
15. Migrate the gateway with the approved migration task.
16. Deploy the consuming gateway with writes controlled.
17. Verify the seeded template.
18. Verify historical handoff backfill under the actual migrator's RLS identity.
19. Exercise the human freeze review and hardware-signing workflow.
20. Check each recorded transaction's chain-monitor status.

Only reconciliation may sign findings and action-evidence replies. Terraform apply requires owner authorization. Keep historical verification keys during rotation.

Keep evidence endpoints off the ALB. Permit ingress through the existing gateway security-group rule only.

Missing or stale assurance must refuse privileged actions. `record` temporarily relaxes step-up enforcement only. It does not bypass evidence verification.

### Browser and recovery acceptance

1. Build Dash with the trusted public keys and deployed chain context.
2. Exercise stale-session recovery against the deployed API.
3. Exercise logout and account-switch failures.
4. Exercise the template approval lifecycle.
5. Exercise browser verification of containment evidence.
6. Repeat these browser checks at desktop and mobile widths.
7. Rehearse recovery with the exact image digests and schema head.
8. Review the recovery checks before reopening writes.
9. Record candidate-bound release evidence for each original criterion.
10. Close only criteria supported by the accepted evidence.

Mocked browser checks do not satisfy deployed acceptance. Approval, hardware broadcast and confirmed execution are distinct states.

Older images cannot ignore unknown migrations. Preserve signed evidence, approvals and immutable terms during forward recovery. Keep treasury verification active.

If signatures, KMS, evidence transport or migrations fail, hold affected operations. Restore the dependency or repair forward. Do not publish unsigned findings or infer clean evidence from a network error.

## What remains outside local acceptance

- Owner-reviewed Terraform plan/apply and KMS-mode execution under the deployed task role.
- Hosted checks and review on the final delivered PR heads; merge order and post-merge checks.
- Staging and deployed-API browser evidence, real hardware login/signing, and digest-bound recovery rehearsal.
- Mandate-dependent Dash #227 criteria, provider-related #228/#944 criteria, and unrelated M6 #939 requirements. Preserve these as open scope; do not change issue wording to claim completion.
- Agroasys #797 closeout only after the accepted Cotsel auth change is delivered with its fixture proof. A local continuation branch is not that delivery.

## Dependency backport

The candidate retains i18next 25 compatibility and backports the upstream own-property check for GHSA-6jcc-5g8w-32mx to each distributed JavaScript entry point. The exact patch and advisory metadata stay under the existing strict dependency gate. Seven public API regressions cover those builds. Replace the backport when a compatible upstream fixed release is adopted; do not broaden advisory exclusions or lower severity thresholds. Upstream fix: <https://github.com/i18next/i18next/commit/642137b>.
