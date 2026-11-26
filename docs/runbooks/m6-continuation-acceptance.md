# M6 continuation acceptance

Use this record to assess the four-issue continuation. It is for maintainers, release owners and security reviewers. Full M6 programme acceptance remains open.

## Accepted decisions

Use these decisions to assess the candidate:

| Decision | Required behavior                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1       | Normal quorum-controlled unpause applies to a non-reconciliation pause only when fresh authenticated evidence confirms no open reconciliation containment. Errors refuse the action.                                                       |
| Q2       | Reconciliation recovery requires verified clean clearance for the exact trade and incident episode. The clearance must be newer than its divergence evidence.                                                                              |
| Q3       | Template activation requires durable preparation, independent approval and confirmation of the exact hash and predecessor. A reviewer must accept the off-chain adapter. A direct two-person status change does not meet that requirement. |
| Q4       | Dash independently verifies signed finding evidence with configured trusted public keys.                                                                                                                                                   |
| Q5       | A freeze request has durable signed references, a recorded human decision and a recorded execution lifecycle. Reconciliation never signs governance transactions.                                                                          |

## Source implementation and local proof

The review items below record the implementation and the scope of local proof:

### R01–R03: Reconciliation recovery

Each run signs the chain and escrow context, incident snapshot, episode and finding lineage. Shared recovery tests, PostgreSQL lineage tests and gateway unpause route tests cover borrowed evidence and repeated divergence. They also cover stale proof, invalid proof and exact-trade clearance.

### R04: Session recovery

Dash saves the replayable JSON request and idempotency key. JSON means JavaScript Object Notation. Dash combines concurrent recovery requests and checks the operator and session revision. It refuses identity switches and invalidates the local session before logout waits for the network. Application programming interface (API) tests cover the logout and retry race.

### R05–R06: Settlement template activation

Template approval binds the exact target hash and predecessor. The server rechecks the current activation allowlist at confirmation. If the approval is stale, the server commits supersession before it refuses the request. Deferred Structured Query Language (SQL) constraints require replacement and confirmation in one transaction. The approval actors and timestamps stay immutable.

### R07: Freeze requests

The same transaction records the signed opening run and its immutable freeze request. Gateway migration 020 records human decisions and their audit rows together. Hardware-signing preparation binds the exact request and trade. Chain observations stay separate from approval.

### R08: Browser verification

Node and WebCrypto verify the same public signed fixture. Connected adapter and real Chromium tests reject tampered evidence even when the server reports it as verified. Browser code and fixtures contain no private signing keys.

### R09–R10: Notification callbacks

Migration 019 records a callback envelope. It preserves the original Hypertext Transfer Protocol (HTTP) callback bytes. Registered notification envelopes keep their event identity during deduplication. The service refuses invalid events. Direct delivery cannot bypass that refusal.

### R11: Break-glass assurance

Break-glass audit records retain the operator's authentication assurance. Refresh preserves the original authentication time.

### R12–R13: Containment and handoff display

Containment and handoff sections load independently. Keyset pagination exposes a continuation cursor. If a later page fails, Dash reports the incomplete list and keeps prior pages visible.

### D1: Image and migration recovery

An older image refuses startup if its manifest lacks an applied migration. Local database tests exercise current manifests and old-manifest refusal while preserving the ledger. Release requires a reviewed rehearsal of a compatibility-image or forward-repair deployment with exact image digests.

### D2 and R14: Acceptance scope

The original issue criteria remain authoritative. Passing local suites cannot establish hosted continuous integration (CI), deployment, hardware signing or programme completion.

## Schema and migration rules

The candidate adds gateway migrations 017–020, authentication assurance and notification outbox migrations. It also adds signed reconciliation manifests, incident lineage (010) and durable freeze requests (011).

For each service, inspect the exact version and checksum pairs in `migrations.json`. Use both values to identify a migration. After each stack rebase, rebind the candidate-manifest and evidence-index fixtures.

The local source work amends migrations 017 and 018 on the recorded premise that no persistent environment has applied them. Before release, inspect the environment ledger. If the ledger records an applied checksum, preserve it. If the applied migration needs a repair, add a new migration. Keep the applied ledger intact.

`shared-db/m6-forward-recovery.postgres.test.js` tests the startup contract for auth, gateway and reconciliation on real PostgreSQL. It verifies current migration versions and checksums twice. It confirms that an older manifest fails and that the ledger stays intact. Full application-image compatibility, rollback timing and staging behavior require deployment evidence.

## Release sequence and stop conditions

### Source acceptance

Use this sequence to prepare the source changes for acceptance:

1. Review the exact backend and Dash candidate commits.
2. Split delivery into dependency-ordered pull requests (PRs).
3. After each rebase, rebind the release-evidence fixtures.
4. Run the required checks for each changed candidate.

Before changing an approved remote PR, follow the agreed process for post-approval changes.

### Infrastructure and backend deployment

Among runtime task roles, only reconciliation has permission to sign findings and action-evidence replies. Terraform apply requires owner authorization. During rotation, keep the public keys that verify historical evidence.

Keep evidence endpoints off the Application Load Balancer (ALB). Limit ingress to the existing gateway security-group rule.

If assurance is missing or stale, the gateway must refuse privileged actions. The `record` mode temporarily relaxes only step-up enforcement. Evidence verification remains mandatory.

The release owner must approve a cutover plan that holds writes and drains each old runtime before its migration. Runtime images check the ledger; they do not apply migrations. These steps describe the dependency order for the complete forward release. They do not establish deployed acceptance.

Deploy infrastructure and backend services in this order:

1. Review the AWS Key Management Service (KMS) policy.
2. Review the Terraform plan.
3. With owner authorization, apply the approved foundation plan.
4. With owner authorization, apply the approved platform plan.
5. Deploy Agroasys break-glass assurance.
6. Migrate auth with the approved migration task.
7. Deploy Cotsel auth assurance.
8. Verify the real signed session exchange.
9. Verify the real break-glass grant exchange.
10. Migrate reconciliation with the approved migration task.
11. Deploy reconciliation with signing, lineage and freeze-request support.
12. Wait for a signed completed run.
13. Check the access restrictions on the internal evidence endpoint.
14. Deploy treasury with the trusted public keys.
15. Test refusal of unsigned evidence.
16. Test refusal of invalid evidence.
17. Migrate the gateway with the approved migration task.
18. With writes controlled, deploy the complete gateway image that requires those migrations.
19. Verify gateway step-up enforcement in the approved test window.
20. Verify the seeded template.
21. Under the actual migrator's row-level security (RLS) identity, verify the historical handoff backfill.
22. Exercise human review of a freeze request.
23. Exercise the hardware-signing workflow.
24. Check the chain-monitor status for each recorded transaction.

The gateway image also requires the signed-evidence producer. Do not start the complete image before its migrations and that producer are ready. Use [Staging service database migrations](staging-service-migrations.md) for the dedicated migration tasks.

### Browser and recovery acceptance

For deployed acceptance, run browser checks against the deployed API. Approval, hardware broadcast and confirmed execution are separate states.

An older image cannot ignore an unknown migration. During forward recovery, preserve signed evidence, approvals and immutable terms. Keep treasury verification active.

Use this sequence to verify browser behavior and recovery:

1. Build Dash with the trusted public keys and deployed chain context.
2. Exercise stale-session recovery against the deployed API.
3. Exercise logout failures.
4. Exercise account-switch failures.
5. Exercise the template approval lifecycle.
6. Exercise browser verification of containment evidence.
7. Repeat these browser checks at desktop width.
8. Repeat these browser checks at mobile width.
9. Rehearse recovery with the exact image digests and schema head.
10. Before reopening writes, review the recovery checks.
11. Record release evidence for each original criterion against the exact candidate.
12. Close only the criteria with accepted evidence.

If signatures, KMS, evidence transport or migrations fail, hold the affected operations. If the dependency is unavailable, restore it. If the candidate needs a correction, repair forward. Never publish unsigned findings. A network error cannot establish clean evidence.

## Work that requires further acceptance

The continuation leaves these items open beyond local validation:

- Owner review and authorization for the Terraform plan and apply. KMS-mode execution under the deployed task role.
- Hosted checks and review on the final PR heads. Merge order and post-merge checks.
- Staging and browser evidence from the deployed API. Real hardware login and signing. A recovery rehearsal with exact image digests.
- Mandate-dependent Dash #227 criteria, provider-related #228 and #944 criteria, and unrelated M6 #939 requirements. Keep these criteria open with their original wording.
- Closeout of Agroasys #797 after delivery of the accepted Cotsel auth change with its fixture proof. A local continuation branch does not establish delivery.

## Dependency backport

The candidate retains i18next 25 compatibility. It backports the upstream own-property check for GHSA-6jcc-5g8w-32mx to each distributed JavaScript entry point. The existing strict dependency gate covers the exact patch and advisory metadata. Seven public API regressions cover the distributed builds.

When you adopt a compatible upstream release with the fix, replace the backport. Keep the advisory exclusions and severity thresholds intact. See the [upstream i18next fix](https://github.com/i18next/i18next/commit/642137b).
