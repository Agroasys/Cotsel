#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'docs/readiness', name), 'utf8'));
const source = read('cotsel-production-readiness-sow-source.json');
const routes = read('cotsel-production-readiness-issue-route-contract.json');
const coverage = read('cotsel-production-readiness-supporting-coverage-contract.json');
const packages = read('cotsel-production-readiness-work-packages.json');

const findingById = new Map(source.findings.map((item) => [item.id, item]));
const controlById = new Map(
  Object.values(coverage.groups).flatMap((group) => group.entries.map((item) => [item.id, item])),
);
const routeByKey = new Map(routes.issues.map((item) => [item.key, item]));
const packageById = new Map(packages.workPackages.map((item) => [item.id, item]));

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function row(id, requiredWork, implementationRequirement, acceptanceEvidence) {
  return `| ${escapeCell(id)} | ${escapeCell(requiredWork)} | ${escapeCell(implementationRequirement)} | ${escapeCell(acceptanceEvidence)} |`;
}

function requirementTable(route) {
  const rows = [];
  for (const id of route.findingIds) {
    const finding = findingById.get(id);
    rows.push(
      row(
        finding.id,
        finding.requiredWork,
        finding.implementationRequirement,
        finding.acceptanceEvidence,
      ),
    );
  }
  for (const id of route.controlIds) {
    const control = controlById.get(id);
    rows.push(
      row(
        control.id,
        control.name,
        `Implement this control as an explicit, reviewable part of ${route.outcome.toLowerCase()} Preserve the SOW authority boundaries, negative paths, and release identity; do not substitute a process claim for an enforced control.`,
        `Provide release-bound evidence that proves “${control.name}” in the deployed path, identifies the producing command or system, records reviewer acceptance, and includes the applicable failure or recovery result.`,
      ),
    );
  }
  return [
    '| ID | Required work | Implementation requirement | Acceptance evidence |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function bullets(values, fallback = 'None.') {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${fallback}`;
}

function routeBody(route) {
  const wp = packageById.get(route.wp);
  const dependencies = route.dependencies.map((key) => {
    const dependency = routeByKey.get(key);
    return `\`${key}\` — ${dependency.title}`;
  });
  const supporting = route.supportingIssues.map((number) => `Agroasys/Cotsel#${number}`);
  const hasFailure = route.controlIds.some((id) => id.startsWith('FAIL-'));
  const negativeText = hasFailure
    ? 'Execute every failure and recovery scenario assigned in the table. Capture the trigger, containment, retry or recovery decision, restored invariant, and operator-visible result.'
    : 'Test invalid identity, role, state, amount, duplicate, stale, replayed, timeout, partial-success, unavailable-dependency, and rollback paths wherever they can affect this scope. Rejection must be safe, observable, and must not create ambiguous financial or chain state.';

  return `## Outcome

${route.outcome}

## Governing source and traceability

This issue implements ${route.wp} of the **Cotsel Production Readiness and Controlled-Pilot Statement of Work**, dated 2 August 2026. The source PDF SHA-256 is \`${source.source.sha256}\`. The SOW’s current verdict is **NO-GO**; this issue is implementation work, not release authorization.

${requirementTable(route)}

## Current verified state

- The SOW records this programme as NO-GO until the applicable engineering and pilot gates accept evidence from one pinned release.
- A merged pull request, a closed issue, a local test, or an unpinned screenshot does not prove readiness.
- Existing issues listed below are supporting implementation history or adjacent delivery lanes. They do not replace the acceptance event defined here.

## Protected flow and scope

Implement the complete deployed-path outcome above. Preserve the source-of-truth boundaries between the Cotsel contract, gateway, signer, chain, indexer, treasury, reconciliation, Agroasys services, dashboard, providers, and operators. Include configuration, migration, runtime, security, observability, recovery, documentation, and evidence changes needed to make the outcome repeatable.

The delivery must be deterministic and idempotent where retries are possible. It must bind all evidence to the same release manifest, environment, chain, contract address, provider mode, database or migration identity, and artifact digest. Any material change invalidates stale evidence and reopens the affected acceptance review.

## Ownership

- **Accountable owner:** ${route.accountable}
- **Delivery owner:** ${route.delivery}
- **Acceptance owner:** ${route.acceptance}
- **GitHub assignees:** @Astton and @czpyioe
- **Delivery surface:** ${route.surface}
- **External dependency:** ${route.external}

Role descriptions above define decision authority. GitHub assignment coordinates execution and does not allow a delivery owner to self-accept evidence where independent or four-eyes acceptance is required.

## Dependencies

${bullets(dependencies, 'No predecessor issue. The programme charter and pinned release rules still apply.')}

## Supporting existing Cotsel issues

${bullets(supporting, 'No existing Cotsel issue is relied on as the supporting delivery lane.')}

Before implementation, revalidate each supporting issue against the current default branch and the exact requirement table. Reuse valid work; do not assume a closed issue or previous milestone means the control is satisfied.

## Implementation requirements

1. Confirm the current deployed and default-branch state, including every relevant contract, service, configuration, data store, job, provider, and cross-repository interface.
2. Record the design and authority decision before changing an externally visible protocol, financial state, signer rule, data contract, or operational control.
3. Implement the table requirements without weakening existing security, recovery, accounting, participant-protection, or audit invariants.
4. Add automated tests at the lowest useful layer and deployed-path tests at the highest required layer. A mock may prove local logic but cannot substitute for provider, chain, network, persistence, or cross-repository evidence.
5. Instrument success, rejection, retry, ambiguity, recovery, and operator action with privacy-safe correlation identifiers.
6. Update runbooks, configuration inventories, manifests, schemas, and rollback procedures in the same change set.
7. Produce an evidence bundle that an independent reviewer can reproduce without relying on the implementer’s workstation or memory.

## Acceptance criteria

- Every row in the requirement table is implemented and mapped to one or more evidence artifacts.
- Positive, negative, boundary, concurrency, retry, replay, timeout, partial-failure, recovery, and rollback behavior is tested where applicable.
- The deployed artifact and configuration match the reviewed source and are identified by immutable digest or equivalent identity.
- Runtime evidence comes from the intended environment and exact release candidate, not from an untracked local or historical build.
- No unresolved Critical or High defect affects this scope. Any formally waived residual risk names the authority, expiry, compensating control, and affected gate.
- The acceptance owner reviews the evidence and records Accepted or Rejected. Delivery completion alone leaves the issue in Evidence Review.

## Negative and failure cases

${negativeText}

Confirm that failures cannot silently advance settlement, lose a durable transaction identity, skip reconciliation, expose secrets or personal data, bypass authorization, double-apply money or chain state, or leave operators without a bounded recovery path.

## Evidence required

- Release-manifest reference and evidence-index entries for every requirement row.
- Source commit, immutable artifact or image digest, environment, chain ID, contract address, deployment block, migration identity, provider mode, and execution timestamp as applicable.
- CI, unit, integration, contract, migration, end-to-end, security, failure-injection, performance, and operational results required by this scope.
- Redacted logs, metrics, traces, transaction hashes, reconciliation outputs, provider receipts, screenshots, or signed approvals sufficient to reproduce the result.
- Reviewer identity, review date, decision, exceptions, and evidence invalidation triggers.

## Rollback and containment

${wp.rollback}

Document the last known-good release or state, the rollback or forward-fix decision point, data and chain reconciliation steps, communication owner, and proof that rollback does not strand or duplicate participant value.

## Residual risk

${wp.residualRisk}

## Non-goals

- This issue does not authorize the controlled pilot or Base mainnet by itself.
- This issue does not allow invented product, legal, finance, compliance, signer, provider, or cloud decisions.
- Base mainnet work remains separate unless this issue is explicitly assigned to ${route.wp} and the Base Mainnet track.
- Evidence from a different commit, digest, address, environment, provider mode, or data state cannot be reused without documented equivalence and reviewer approval.

## Closure and invalidation rule

Close only after implementation is complete, evidence is complete, and the named acceptance owner records acceptance for the pinned release. Reopen this issue if its source, artifact, environment, chain, address, migration, provider, authority boundary, assumption, or acceptance evidence changes materially.
`;
}

function parentBody(wp) {
  const children = routes.issues.filter((item) => item.wp === wp.id);
  const findings = children.flatMap((item) => item.findingIds);
  const controls = children.flatMap((item) => item.controlIds);
  return `## Objective

${wp.objective}

## Governing source

This parent controls ${wp.id} under the **Cotsel Production Readiness and Controlled-Pilot Statement of Work**, dated 2 August 2026, source SHA-256 \`${source.source.sha256}\`. The programme remains **NO-GO** until the applicable release-specific gates accept complete evidence.

## Work-package control sheet

| Control | Definition |
|---|---|
| Owner | ${wp.owner} |
| Dependencies | ${wp.dependencies} |
| Implementation | ${wp.implementation} |
| Verification | ${wp.verification} |
| Evidence | ${wp.evidence} |
| Rollback | ${wp.rollback} |
| Residual risk | ${wp.residualRisk} |
| Primary gate | ${wp.gate} |
| Programme track | ${wp.track} |

## Required-work coverage

| ID | Required work | Implementation requirement | Acceptance evidence |
|---|---|---|---|
| ${wp.id} | Deliver the complete ${wp.title.toLowerCase()} work package. | Complete every child issue below, preserve all authority and safety boundaries, and resolve or formally accept every dependency and residual risk. | An accepted release-bound evidence index maps every SOW finding and supporting control to reproducible proof and the named acceptance decision. |

This work package owns ${findings.length} finding rows (${findings.length ? findings.join(', ') : 'none'}) and ${controls.length} supporting control assignments (${controls.length ? controls.join(', ') : 'none'}). The machine-readable contracts in \`docs/readiness/\` are authoritative for coverage reconciliation.

## Child delivery issues

${children.map((item) => `- \`${item.key}\` — ${item.title}`).join('\n')}

## Exit criterion

The work package exits only when every child is implemented, every assigned finding and supporting control has complete evidence from the same pinned release, dependencies are accepted, residual risks are explicitly recorded, and the named acceptance authority accepts the package. Child closure or code merge alone is insufficient.

## Change and invalidation rule

Reopen this parent and every affected child when a material source, artifact, environment, chain, contract, migration, provider, authority, assumption, or evidence change invalidates the accepted basis. Base mainnet authorization remains a separate decision from engineering rehearsal and controlled-pilot authorization.
`;
}

function programmeBody() {
  const findingCounts = Object.groupBy(source.findings, (item) => item.priority);
  return `## Programme outcome

Move Cotsel from the SOW’s verified **NO-GO** state through evidence-led engineering remediation, a pinned Base Sepolia rehearsal, controlled-pilot authorization, and only then a separately authorized Base mainnet programme.

## Governing source and completeness contract

- **Source:** Cotsel Production Readiness and Controlled-Pilot Statement of Work, 2 August 2026
- **Source SHA-256:** \`${source.source.sha256}\`
- **Source pages:** ${source.source.pageCount}
- **Findings:** ${source.findings.length} total — ${findingCounts.P0.length} P0 blockers, ${findingCounts.P1.length} P1 prerequisites, ${findingCounts.P2.length} P2 improvements
- **Primary delivery issues:** ${routes.issues.length}
- **Supporting SOW controls:** ${controlById.size}
- **Work packages:** ${packages.workPackages.length}, WP-0 through WP-12
- **GitHub Project:** https://github.com/orgs/Agroasys/projects/9

The machine-readable source, issue-route, supporting-coverage, and work-package contracts under \`docs/readiness/\` prevent skipped or duplicated requirements. Every primary issue contains the exact columns **ID**, **Required work**, **Implementation requirement**, and **Acceptance evidence**.

| ID | Required work | Implementation requirement | Acceptance evidence |
|---|---|---|---|
| PROGRAMME | Govern the complete Cotsel production-readiness and controlled-pilot programme without losing, duplicating, or weakening any SOW requirement. | Maintain the programme hierarchy, validated coverage contracts, release identity, authority boundaries, evidence lifecycle, gate model, milestone alignment, and separate mainnet authorization until all applicable work is accepted. | A reproducible programme audit proves all 58 findings, 131 supporting controls, 13 work packages, 56 primary delivery issues, seven engineering gates, seven pilot gates, and six mainnet conditions are uniquely mapped and accepted for the applicable pinned release. |

## Programme rules

1. All programme and delivery issues live in \`Agroasys/Cotsel\` and are assigned only to @Astton and @czpyioe.
2. Cross-repository, cloud, chain, signer, dashboard, backend, frontend, and provider work is represented honestly as a delivery surface or external dependency; a Cotsel assignee cannot self-accept evidence owned by another authority.
3. “Implementation complete,” “evidence complete,” “evidence accepted,” and “gate accepted” are distinct states.
4. A merge, closed issue, local test, or historical milestone is not readiness evidence.
5. Evidence must bind to one release manifest containing immutable application, contract, configuration, infrastructure, migration, provider, chain, and rollback identities.
6. Material changes invalidate stale evidence and reopen affected work and gates.
7. Engineering rehearsal and controlled-pilot approval do not authorize Base mainnet. Mainnet requires WP-12 and an explicit four-role GO decision.
8. Percentage complete is prohibited because it obscures blocked gates and unaccepted evidence.

## Work-package hierarchy

${packages.workPackages.map((wp) => `- **${wp.id}: ${wp.title}** — gate ${wp.gate}; track ${wp.track}; milestone ${wp.milestone}.`).join('\n')}

## Dependency sequence

Start with WP-0 scope and authority. Establish the canonical contract and protocol boundary in WP-1; transaction durability in WP-2; indexer and reconciliation truth in WP-3; treasury safety in WP-4; migrations and recovery in WP-5; release integrity in WP-6; platform controls in WP-7; observability and operations in WP-8; cross-repository journeys in WP-9; independent assurance in WP-10; then conduct the controlled pilot in WP-11. WP-12 starts only after the pilot and is the sole mainnet authorization track.

## Gate model

- **E-0 to E-5:** engineering authority, build, deployed-path, recovery, assurance, and Base Sepolia rehearsal acceptance.
- **P-0 to P-6:** release identity, participant controls, journey proof, financial integrity, operational readiness, residual-risk acceptance, and controlled-pilot GO.
- **Mainnet:** separate deployment, signer, provider, operations, rollback, assurance, and four-role approval.

Create release-specific gate reviews only when a real candidate exists. Each gate review must name the exact release manifest, evidence index, backend and frontend identities, Cotsel artifact and contract identities, infrastructure and migration identities, chain and provider modes, reviewer, decision, exceptions, and rollback target.

## Closure rule

This programme closes only when all required SOW rows and supporting controls are implemented, evidence is complete and accepted for one pinned release, the controlled pilot exits under its approved criteria, residual risks are accepted by named authorities, and any requested mainnet work has separately satisfied WP-12. If mainnet is not requested, WP-12 remains explicitly deferred and does not become an implied pilot requirement.
`;
}

const args = process.argv.slice(2);
if (args.includes('--programme')) {
  process.stdout.write(programmeBody());
} else if (args.includes('--parent')) {
  const id = args[args.indexOf('--parent') + 1];
  const wp = packageById.get(id);
  if (!wp) throw new Error(`Unknown work package: ${id}`);
  process.stdout.write(parentBody(wp));
} else if (args.includes('--issue')) {
  const key = args[args.indexOf('--issue') + 1];
  const route = routeByKey.get(key);
  if (!route) throw new Error(`Unknown issue route: ${key}`);
  process.stdout.write(routeBody(route));
} else {
  throw new Error('Use --programme, --parent WP-N, or --issue <route-key>');
}
