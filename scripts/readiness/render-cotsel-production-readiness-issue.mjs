#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  controls,
  contributingControlsForRoute,
  findingById,
  gateControls,
  gateEvidenceControlsForRoute,
  issueRoutedControls,
  packageById,
  packages,
  primaryControlsForRoute,
  programmeTitle,
  routeByKey,
  routes,
  source,
  titleForWorkPackage,
  workPackageControlSheetLabels,
  workPackageSheetControls,
} from './cotsel-production-readiness-model.mjs';

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function row(id, requiredWork, implementationRequirement, acceptanceEvidence) {
  return `| ${escapeCell(id)} | ${escapeCell(requiredWork)} | ${escapeCell(implementationRequirement)} | ${escapeCell(acceptanceEvidence)} |`;
}

function fourColumnTable(rows) {
  return [
    '| ID | Required work | Implementation requirement | Acceptance evidence |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function primaryRequirementTable(route) {
  const rows = route.findingIds.map((id) => {
    const finding = findingById.get(id);
    return row(
      finding.id,
      finding.requiredWork,
      finding.implementationRequirement,
      finding.acceptanceEvidence,
    );
  });
  for (const control of primaryControlsForRoute(route.key)) {
    rows.push(
      row(
        control.id,
        control.requiredWork,
        control.implementationRequirement,
        control.acceptanceEvidence,
      ),
    );
  }
  return fourColumnTable(rows);
}

function contributionTable(route) {
  const rows = contributingControlsForRoute(route.key).map((control) => {
    const primary = routeByKey.get(control.primaryRoute);
    return row(
      `${control.id} (contributor)`,
      `${control.requiredWork}. Contribute evidence to primary route \`${control.primaryRoute}\` (${primary.title}).`,
      control.implementationRequirement,
      `${control.acceptanceEvidence} Link the result to \`${control.primaryRoute}\`; this issue cannot self-accept ${control.id}.`,
    );
  });
  if (!rows.length) return '';
  return `## Contributing evidence obligations

These rows require evidence from this delivery surface. The named primary route remains the sole acceptance owner.

${fourColumnTable(rows)}
`;
}

function gateEvidenceTable(route) {
  const rows = gateEvidenceControlsForRoute(route.key).map((control) =>
    row(
      `${control.id} (gate evidence)`,
      `${control.requiredWork}. Supply the evidence produced by this issue to the candidate-specific ${control.id} review.`,
      control.implementationRequirement,
      `${control.acceptanceEvidence} This issue supplies evidence but cannot accept or close ${control.id}.`,
    ),
  );
  if (!rows.length) return '';
  return `## Release-gate evidence obligations

Gate acceptance occurs only in a release-specific review created for an exact candidate. This issue cannot self-authorize a rehearsal, pilot, or mainnet release.

${fourColumnTable(rows)}
`;
}

function bullets(values, fallback = 'None.') {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${fallback}`;
}

export function renderRouteBody(route) {
  const workPackage = packageById.get(route.wp);
  const dependencies = route.dependencies.map((key) => {
    const dependency = routeByKey.get(key);
    return `\`${key}\` - ${dependency.title}`;
  });
  const supporting = route.supportingIssues.map((number) => `Agroasys/Cotsel#${number}`);
  const failureIds = [
    ...primaryControlsForRoute(route.key),
    ...contributingControlsForRoute(route.key),
  ].map((item) => item.id);
  const hasFailure = failureIds.some((id) => id.startsWith('FAIL-'));
  const negativeText = hasFailure
    ? 'Execute every failure and recovery scenario assigned in the primary and contributor tables. Capture the trigger, detection, stop condition, recovery authority, restored invariant, reconciliation result, and operator-visible outcome before resumption.'
    : 'Test invalid identity, role, state, amount, duplicate, stale, replayed, timeout, partial-success, unavailable-dependency, and rollback paths wherever they affect this scope. Rejection must be safe, observable, and must not create ambiguous financial or chain state.';

  return `## Outcome

${route.outcome}

## Governing source and primary traceability

This issue implements ${route.wp} of the **Cotsel Production Readiness and Controlled-Pilot Statement of Work**, dated 2 August 2026. The source PDF SHA-256 is \`${source.source.sha256}\`. The SOW's current verdict is **NO-GO**; this issue is implementation work, not release authorization.

The table below contains only findings and supporting controls for which this issue is the primary acceptance route.

${primaryRequirementTable(route)}

${contributionTable(route)}
${gateEvidenceTable(route)}
## Current verified state

- The SOW records this programme as NO-GO until the applicable engineering and pilot gates accept evidence from one pinned release.
- A merged pull request, a closed issue, a local test, or an unpinned screenshot does not prove readiness.
- Existing issues listed below are supporting implementation history or adjacent delivery lanes. They do not replace the acceptance event defined here.

## Protected flow and scope

Implement the complete deployed-path outcome above. Preserve the source-of-truth boundaries between the Cotsel contract, gateway, signer, chain, indexer, treasury, reconciliation, Agroasys services, dashboard, providers, and operators. Include configuration, migration, runtime, security, observability, recovery, documentation, and evidence changes needed to make the outcome repeatable.

The delivery must be deterministic and idempotent where retries are possible. Bind all evidence to the same release manifest, environment, chain, contract address, provider mode, database or migration identity, and artifact digest. A material change invalidates stale evidence and reopens the affected acceptance review.

## Ownership

- **Accountable owner:** ${route.accountable}
- **Delivery owner:** ${route.delivery}
- **Acceptance owner:** ${route.acceptance}
- **GitHub assignees:** @Astton and @czpyioe
- **Delivery surface:** ${route.surface}
- **External dependency:** ${route.external}
- **Primary Project gate:** ${route.primaryGate}

Role descriptions define decision authority. GitHub assignment coordinates execution and does not permit a delivery owner to self-accept evidence where independent or four-eyes acceptance is required.

## Dependencies

${bullets(dependencies, 'No predecessor delivery issue. The programme charter and pinned-release rules still apply.')}

Record any required provider access, legal or compliance decision, cloud permission, and external deployment record before implementation or acceptance. An unresolved external dependency remains explicit and cannot be replaced by Cotsel-local evidence.

## Supporting existing Cotsel issues

${bullets(supporting, 'No existing Cotsel issue is relied on as a supporting delivery lane.')}

Before implementation, revalidate each supporting issue against the current default branch and exact requirement tables. Reuse valid work; do not assume a closed issue or previous milestone means the control is satisfied.

## Implementation requirements

1. Confirm the current deployed and default-branch state, including every relevant contract, service, configuration, data store, job, provider, and cross-repository interface.
2. Record the design and authority decision before changing an externally visible protocol, financial state, signer rule, data contract, or operational control.
3. Implement the primary table requirements and applicable contributor obligations without weakening security, recovery, accounting, participant-protection, or audit invariants.
4. Add automated tests at the lowest useful layer and deployed-path tests at the highest required layer. A mock can prove local logic but cannot replace provider, chain, network, persistence, or cross-repository evidence.
5. Instrument success, rejection, retry, ambiguity, recovery, and operator action with privacy-safe correlation identifiers.
6. Update runbooks, configuration inventories, manifests, schemas, and rollback procedures in the same change set.
7. Produce an evidence bundle that an independent reviewer can reproduce without relying on the implementer's workstation or memory.

## Acceptance criteria

- Every primary row is implemented and mapped to one or more evidence artifacts.
- Every contributor row is delivered to its named primary acceptance route without being self-accepted here.
- Applicable positive, negative, boundary, concurrency, retry, replay, timeout, partial-failure, recovery, load, privacy, cross-repository, and rollback behavior is tested.
- The deployed artifact and configuration match the reviewed source and are identified by immutable digest or equivalent identity.
- Runtime evidence comes from the intended environment and exact candidate, not from an untracked local or historical build.
- No unresolved Critical or High defect affects this scope. A formally accepted residual risk names the authority, expiry, compensating control, and affected gate.
- The acceptance owner records Accepted or Rejected. Delivery completion alone leaves the issue in Evidence Review.

## Negative and failure cases

${negativeText}

Confirm that failures cannot silently advance settlement, lose a durable transaction identity, skip reconciliation, expose secrets or personal data, bypass authorization, double-apply money or chain state, or leave operators without a bounded recovery path.

## Evidence required

- Release-manifest reference and evidence-index entries for every primary and contributor row.
- Source commit, immutable artifact or image digest, environment, chain ID, contract address, deployment block, migration identity, provider mode, redacted configuration digest, and execution timestamp as applicable.
- CI, unit, integration, contract, migration, end-to-end, security, fault, performance, privacy, recovery, and operational results required by this scope.
- Immutable artifact paths or URLs, hashes and run identifiers plus redacted logs, metrics, traces, transaction hashes, reconciliation outputs, provider receipts, screenshots, or signed approvals sufficient to reproduce the result.
- Reviewer identity, review date, decision, exceptions, expiry, and evidence-invalidation triggers.

## Rollback and containment

${workPackage.rollback}

The incident owner is ${route.accountable} with the Incident Commander for a declared incident. Record the last known-good release or state, rollback compatibility window, rollback or forward-fix decision point, data and chain reconciliation steps, communication owner, residual exposure, and proof that rollback does not strand or duplicate participant value.

## Residual risk

${workPackage.residualRisk}

No bounded exception is approved by programme setup. Any exception must name the risk, affected release and gate, compensating control, decision authority, expiry, revocation trigger, and evidence impact.

## Non-goals

- This issue does not authorize the controlled pilot or Base mainnet by itself.
- This issue does not allow invented product, legal, finance, compliance, signer, provider, or cloud decisions.
- Base mainnet work remains separate unless this issue is explicitly assigned to ${route.wp} and the Base Mainnet track.
- Evidence from a different commit, digest, address, environment, provider mode, configuration or data state cannot be reused without documented equivalence and reviewer approval.

## Closure and invalidation rule

Close only after implementation is complete, evidence is complete, and the named acceptance owner records acceptance for the pinned release. Reopen this issue if its source, artifact, environment, chain, address, migration, provider, authority boundary, assumption, or acceptance evidence changes materially.
`;
}

function workPackageControlSheet(workPackage) {
  const definitions = new Map([
    ['Objective', workPackage.objective],
    [
      'In scope / out of scope',
      `**In scope:** ${workPackage.inScope}<br>**Out of scope:** ${workPackage.outOfScope}`,
    ],
    [
      'Owner / reviewers',
      `**Accountable owner:** ${workPackage.owner}<br>**Required reviewers:** ${workPackage.reviewers}`,
    ],
    [
      'Dependencies',
      `${workPackage.dependencies} Acceptance must also identify required provider access, legal or compliance decisions, and external deployment records, or explicitly record that none apply.`,
    ],
    ['Implementation', workPackage.implementation],
    ['Verification', workPackage.verification],
    [
      'Acceptance evidence',
      `${workPackage.evidence} For a candidate, record immutable paths or URLs, hashes, run IDs, environment identity, approvers, and decision timestamps. Current accepted evidence: none.`,
    ],
    [
      'Rollback / containment',
      `${workPackage.rollback} Incident owner: ${workPackage.owner} with the Incident Commander for a declared incident. Record rollback compatibility and residual exposure.`,
    ],
    [
      'Residual risk',
      `${workPackage.residualRisk} Approved bounded exception: none at programme setup. A future exception must name its decision authority, expiry, compensating control, and invalidation trigger.`,
    ],
  ]);
  return [
    '| Control | Definition |',
    '|---|---|',
    ...workPackageControlSheetLabels.map(
      (label) => `| ${escapeCell(label)} | ${escapeCell(definitions.get(label))} |`,
    ),
  ].join('\n');
}

export function renderParentBody(workPackage) {
  const children = routes.issues.filter((item) => item.wp === workPackage.id);
  const findingIds = children.flatMap((item) => item.findingIds);
  const primaryControlIds = children.flatMap((item) =>
    primaryControlsForRoute(item.key).map((control) => control.id),
  );
  const contributorIds = new Set(
    children.flatMap((item) => contributingControlsForRoute(item.key).map((control) => control.id)),
  );
  return `## Governing source

This parent controls ${workPackage.id} under the **Cotsel Production Readiness and Controlled-Pilot Statement of Work**, dated 2 August 2026, source SHA-256 \`${source.source.sha256}\`. The programme remains **NO-GO** until the applicable release-specific gates accept complete evidence.

## Work-package control sheet

This is the complete nine-field decision record required by SOW Section 9.1. Update it when scope, evidence, authority, dependency or risk changes.

${workPackageControlSheet(workPackage)}

## Programme metadata

| Field | Value |
|---|---|
| Primary gate | ${workPackage.gate} |
| Programme track | ${workPackage.track} |
| Milestone | ${workPackage.milestone} |
| Risk | ${workPackage.risk} |

## Required-work coverage

| ID | Required work | Implementation requirement | Acceptance evidence |
|---|---|---|---|
| ${workPackage.id} | Deliver the complete ${workPackage.title.toLowerCase()} work package. | Complete every child issue, preserve the nine-field control sheet, resolve or formally accept dependencies and residual risks, and keep release-gate acceptance separate from implementation completion. | An accepted release-bound evidence index maps every primary finding and control to reproducible proof, immutable identities, named reviewers and the acceptance decision. |

This work package owns ${findingIds.length} finding rows (${findingIds.length ? findingIds.join(', ') : 'none'}) and ${primaryControlIds.length} primary supporting controls (${primaryControlIds.length ? primaryControlIds.join(', ') : 'none'}). It also contributes evidence to ${contributorIds.size} controls accepted elsewhere. WPCS-01 through WPCS-09 apply structurally to this parent and are validated against the exact table above.

## Child delivery issues

${children.map((item) => `- \`${item.key}\` - ${item.title}`).join('\n')}

## Exit criterion

The work package exits only when every child is implemented, every primary finding and control has complete evidence from the same pinned release, required contributor evidence is delivered, dependencies are accepted, residual risks are recorded, and the named authority accepts the package. Child closure or code merge alone is insufficient.

## Change and invalidation rule

Reopen this parent and every affected child when a material source, artifact, environment, chain, contract, migration, provider, authority, assumption, risk or evidence change invalidates the accepted basis. Base mainnet authorization remains separate from engineering rehearsal and controlled-pilot authorization.
`;
}

export function renderProgrammeBody() {
  const p0 = source.findings.filter((item) => item.priority === 'P0').length;
  const p1 = source.findings.filter((item) => item.priority === 'P1').length;
  const p2 = source.findings.filter((item) => item.priority === 'P2').length;
  const gateRows = gateControls.map((control) =>
    row(
      control.id,
      control.requiredWork,
      control.implementationRequirement,
      control.acceptanceEvidence,
    ),
  );
  return `## Programme outcome

Move Cotsel from the SOW's verified **NO-GO** state through evidence-led engineering remediation, a pinned Base Sepolia rehearsal, controlled-pilot authorization, and only then a separately authorized Base mainnet programme.

## Governing source and completeness contract

- **Source:** Cotsel Production Readiness and Controlled-Pilot Statement of Work, 2 August 2026
- **Source SHA-256:** \`${source.source.sha256}\`
- **Source pages:** ${source.source.pageCount}
- **Source finding rows:** ${source.findings.length} total - ${p0} P0 blockers, ${p1} P1 prerequisites, ${p2} P2 improvements
- **Normalized supporting controls:** ${controls.length} - ${issueRoutedControls.length} issue-routed, ${gateControls.length} release-gate definitions, and ${workPackageSheetControls.length} structural work-package fields
- **Primary delivery issues:** ${routes.issues.length}
- **Work packages:** ${packages.workPackages.length}, WP-0 through WP-12
- **GitHub Project:** https://github.com/orgs/Agroasys/projects/9

The 58 B, H and I finding rows preserve the SOW's four source columns. Supporting controls normalize other SOW tables and governing prose into the same four-column shape and identify their source section and page; those normalized rows are structured paraphrases, not claimed as verbatim source columns. Coverage routing, detailed requirements, milestones, reused-issue metadata and work-package definitions are independently validated.

| ID | Required work | Implementation requirement | Acceptance evidence |
|---|---|---|---|
| PROGRAMME | Govern the complete Cotsel production-readiness and controlled-pilot programme without losing, duplicating, weakening or falsely accepting any SOW requirement. | Maintain the validated hierarchy, source and coverage contracts, release identity, authority boundaries, evidence lifecycle, gate model, milestone contract and separate mainnet authorization until all applicable work is accepted. | A reproducible local and live audit deep-compares every managed body and milestone and proves complete source, control, Project, hierarchy, assignee and acceptance-state integrity for the applicable release. |

## Release-gate definitions

Create a gate-review issue only when an exact candidate exists. The gate review, not an implementation issue, owns acceptance.

${fourColumnTable(gateRows)}

## Programme rules

1. All programme and delivery issues live in \`Agroasys/Cotsel\` and are assigned only to @Astton and @czpyioe.
2. Cross-repository, cloud, chain, signer, dashboard, backend, frontend and provider work is represented as a delivery surface or external dependency; a Cotsel assignee cannot self-accept evidence owned by another authority.
3. Implementation complete, evidence complete, evidence accepted and gate accepted are distinct states.
4. A merge, closed issue, local test or historical milestone is not readiness evidence.
5. Evidence must bind to one release manifest containing immutable application, contract, configuration, infrastructure, migration, provider, chain and rollback identities.
6. Material changes invalidate stale evidence and reopen affected work and gates.
7. Engineering rehearsal and controlled-pilot approval do not authorize Base mainnet. Mainnet requires WP-12 and an explicit four-role GO decision.
8. Percentage complete is prohibited because it obscures blocked gates and unaccepted evidence.

## Work-package hierarchy

${packages.workPackages.map((workPackage) => `- **${workPackage.id}: ${workPackage.title}** - gate ${workPackage.gate}; track ${workPackage.track}; milestone ${workPackage.milestone}.`).join('\n')}

## Dependency sequence

Start with WP-0 scope and authority. Establish the canonical contract and protocol boundary in WP-1; transaction durability in WP-2; indexer and reconciliation truth in WP-3; treasury safety in WP-4; migrations and recovery in WP-5; release integrity in WP-6; platform controls in WP-7; observability and operations in WP-8; cross-repository journeys in WP-9; independent assurance in WP-10; then conduct the controlled pilot in WP-11. WP-12 starts only after the pilot and is the sole mainnet authorization track.

## Closure rule

This programme closes only when all required SOW rows and supporting controls are implemented, evidence is complete and accepted for one pinned release, the controlled pilot exits under its approved criteria, residual risks are accepted by named authorities, and any requested mainnet work separately satisfies WP-12. If mainnet is not requested, WP-12 remains explicitly deferred and does not become an implied pilot requirement.
`;
}

export function renderBodyForTitle(title) {
  if (title === programmeTitle) return renderProgrammeBody();
  const workPackage = packages.workPackages.find(
    (candidate) => titleForWorkPackage(candidate) === title,
  );
  if (workPackage) return renderParentBody(workPackage);
  const route = routes.issues.find((candidate) => candidate.title === title);
  if (route) return renderRouteBody(route);
  throw new Error(`Unknown managed issue title: ${title}`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--programme')) {
    process.stdout.write(renderProgrammeBody());
  } else if (args.includes('--parent')) {
    const id = args[args.indexOf('--parent') + 1];
    const workPackage = packageById.get(id);
    if (!workPackage) throw new Error(`Unknown work package: ${id}`);
    process.stdout.write(renderParentBody(workPackage));
  } else if (args.includes('--issue')) {
    const key = args[args.indexOf('--issue') + 1];
    const route = routeByKey.get(key);
    if (!route) throw new Error(`Unknown issue route: ${key}`);
    process.stdout.write(renderRouteBody(route));
  } else {
    throw new Error('Use --programme, --parent WP-N, or --issue <route-key>');
  }
}
