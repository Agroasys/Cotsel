#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ORGANIZATION = process.env.READINESS_ORGANIZATION || 'Agroasys';
const REPOSITORY = process.env.READINESS_REPOSITORY || 'Cotsel';
const PROJECT_NUMBER = Number(process.env.READINESS_PROJECT_NUMBER || '9');
const TOKEN = process.env.READINESS_PROJECT_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) throw new Error('READINESS_PROJECT_TOKEN or GH_TOKEN is required for the live audit.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'docs/readiness', name), 'utf8'));
const routes = read('cotsel-production-readiness-issue-route-contract.json');
const packages = read('cotsel-production-readiness-work-packages.json');
const source = read('cotsel-production-readiness-sow-source.json');
const coverage = read('cotsel-production-readiness-supporting-coverage-contract.json');
const programmeTitle = '[Programme] Cotsel production readiness and controlled-pilot authorization';
const requiredTable = '| ID | Required work | Implementation requirement | Acceptance evidence |';

async function github(pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'agroasys-cotsel-readiness-live-audit',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`GitHub request failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function graphql(query, variables = {}) {
  const payload = await github('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length)
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

const data = await graphql(
  `
    query ($organization: String!, $repository: String!, $projectNumber: Int!, $label: String!) {
      organization(login: $organization) {
        projectV2(number: $projectNumber) {
          id
          title
          public
          closed
          repositories(first: 10) {
            nodes {
              nameWithOwner
            }
          }
          fields(first: 100) {
            totalCount
            nodes {
              ... on ProjectV2FieldCommon {
                name
              }
            }
          }
          views(first: 50) {
            totalCount
            nodes {
              name
              number
              layout
              filter
            }
          }
          items(first: 100) {
            totalCount
            nodes {
              id
              content {
                ... on Issue {
                  number
                  title
                  repository {
                    nameWithOwner
                  }
                  assignees(first: 10) {
                    nodes {
                      login
                    }
                  }
                }
              }
              fieldValues(first: 40) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      repository(owner: $organization, name: $repository) {
        issues(
          first: 100
          states: [OPEN, CLOSED]
          labels: [$label]
          orderBy: { field: CREATED_AT, direction: ASC }
        ) {
          totalCount
          nodes {
            id
            number
            title
            body
            state
            url
            assignees(first: 10) {
              nodes {
                login
              }
            }
            milestone {
              title
            }
            parent {
              number
              title
            }
            subIssues(first: 100) {
              totalCount
              nodes {
                number
                title
              }
            }
          }
        }
      }
    }
  `,
  {
    organization: ORGANIZATION,
    repository: REPOSITORY,
    projectNumber: PROJECT_NUMBER,
    label: 'programme:cotsel-production-readiness',
  },
);

const issues = data.repository.issues.nodes;
const project = data.organization.projectV2;
assert.equal(data.repository.issues.totalCount, 70, 'programme issue count');
assert.equal(issues.length, 70, 'programme issue page is complete');
assert.equal(project.title, 'Cotsel Production Readiness and Controlled Pilot');
assert.equal(project.public, true);
assert.equal(project.closed, false);
assert.deepEqual(
  project.repositories.nodes.map((item) => item.nameWithOwner),
  ['Agroasys/Cotsel'],
);

const byTitle = new Map(issues.map((issue) => [issue.title, issue]));
const programme = byTitle.get(programmeTitle);
assert.ok(programme, 'programme issue exists');
const expectedTitles = [programmeTitle];
for (const wp of packages.workPackages) expectedTitles.push(`[${wp.id}] ${wp.title}`);
expectedTitles.push(...routes.issues.map((route) => route.title));
assert.equal(new Set(expectedTitles).size, 70, 'expected titles are unique');
assert.deepEqual(
  [...byTitle.keys()].sort(),
  [...expectedTitles].sort(),
  'live issue titles match route contract',
);

for (const issue of issues) {
  assert.deepEqual(
    issue.assignees.nodes.map((item) => item.login).sort(),
    ['Astton', 'czpyioe'],
    `assignees for #${issue.number}`,
  );
  assert.ok(
    issue.body.includes(requiredTable),
    `four-column SOW table missing from #${issue.number}`,
  );
  assert.ok(issue.milestone?.title, `milestone missing from #${issue.number}`);
}

assert.equal(programme.parent, null);
assert.equal(programme.subIssues.totalCount, 13);
for (const wp of packages.workPackages) {
  const parentTitle = `[${wp.id}] ${wp.title}`;
  const parent = byTitle.get(parentTitle);
  const children = routes.issues.filter((route) => route.wp === wp.id);
  assert.equal(parent.parent.number, programme.number, `${wp.id} parent link`);
  assert.equal(parent.milestone.title, wp.milestone, `${wp.id} milestone`);
  assert.equal(parent.subIssues.totalCount, children.length, `${wp.id} child count`);
  assert.deepEqual(
    parent.subIssues.nodes.map((item) => item.title).sort(),
    children.map((item) => item.title).sort(),
    `${wp.id} child titles`,
  );
  for (const route of children) {
    const child = byTitle.get(route.title);
    assert.equal(child.parent.number, parent.number, `${route.key} parent link`);
    assert.equal(child.milestone.title, route.milestone, `${route.key} milestone`);
  }
}

const requiredFields = [
  'Status',
  'Work Package',
  'Programme Track',
  'Primary Gate',
  'SOW Class',
  'SOW ID',
  'Priority',
  'Work Type',
  'Delivery Surface',
  'Evidence Status',
  'Target Release ID',
  'Accountable Owner',
  'Delivery Owner',
  'Acceptance Owner',
  'External Dependency',
  'Risk',
  'Blocked Reason',
  'Target Date',
];
const fieldNames = project.fields.nodes.filter(Boolean).map((field) => field.name);
for (const name of requiredFields)
  assert.ok(fieldNames.includes(name), `Project field missing: ${name}`);
assert.ok(
  !fieldNames.some((name) => /percent|%\s*complete/i.test(name)),
  'percentage-complete field is prohibited',
);

const expectedViews = new Map([
  ['Executive Authorization', ['BOARD_LAYOUT', 'priority:P0 -primary-gate:"Not Applicable"']],
  ['P0 Blockers', ['TABLE_LAYOUT', 'sow-class:"P0 Blocker"']],
  ['Work Packages', ['BOARD_LAYOUT', 'work-type:"Work Package"']],
  ['Engineering Rehearsal', ['BOARD_LAYOUT', 'programme-track:"Base Sepolia Rehearsal"']],
  [
    'Controlled Pilot Gates',
    ['BOARD_LAYOUT', 'programme-track:"Controlled Pilot" work-type:"Gate Review"'],
  ],
  ['Release Candidate', ['TABLE_LAYOUT', '-no:target-release-id']],
  ['Evidence Review', ['TABLE_LAYOUT', 'status:"Evidence Review"']],
  ['Cross-Repository Dependencies', ['TABLE_LAYOUT', 'external-dependency:Yes']],
  ['Blocked Work', ['TABLE_LAYOUT', 'status:Blocked']],
  ['Decision Queue', ['BOARD_LAYOUT', 'work-type:Decision -status:Accepted']],
  ['P1-P2 Register', ['TABLE_LAYOUT', 'sow-class:"P1 Prerequisite","P2 Improvement"']],
  ['Failure and Recovery Coverage', ['TABLE_LAYOUT', 'label:"control:failure-recovery"']],
  ['Base Mainnet Register', ['ROADMAP_LAYOUT', 'programme-track:"Base Mainnet"']],
]);
assert.equal(project.views.totalCount, expectedViews.size);
for (const view of project.views.nodes)
  assert.deepEqual([view.layout, view.filter], expectedViews.get(view.name), `view ${view.name}`);

assert.equal(project.items.totalCount, 85, 'Project item count');
assert.equal(project.items.nodes.length, 85, 'Project item page is complete');
const expectedProjectNumbers = new Set([
  ...issues.map((issue) => issue.number),
  ...new Set(routes.issues.flatMap((route) => route.supportingIssues)),
]);
assert.equal(expectedProjectNumbers.size, 85);
const projectItems = project.items.nodes.filter(
  (item) => item.content?.repository?.nameWithOwner === 'Agroasys/Cotsel',
);
assert.deepEqual(
  projectItems.map((item) => item.content.number).sort((a, b) => a - b),
  [...expectedProjectNumbers].sort((a, b) => a - b),
  'Project contains exact primary and supporting issue set',
);
const requiredPopulated = [
  'Status',
  'Programme Track',
  'Primary Gate',
  'SOW Class',
  'SOW ID',
  'Priority',
  'Work Type',
  'Delivery Surface',
  'Evidence Status',
  'Accountable Owner',
  'Delivery Owner',
  'Acceptance Owner',
  'External Dependency',
  'Risk',
];
for (const item of projectItems) {
  assert.deepEqual(
    item.content.assignees.nodes.map((assignee) => assignee.login).sort(),
    ['Astton', 'czpyioe'],
    `Project item #${item.content.number} assignees`,
  );
  const values = new Map(
    item.fieldValues.nodes
      .filter((value) => value.field?.name)
      .map((value) => [value.field.name, value.name ?? value.text]),
  );
  for (const field of requiredPopulated)
    assert.ok(values.get(field), `#${item.content.number} missing ${field}`);
  if (item.content.number !== programme.number)
    assert.ok(values.get('Work Package'), `#${item.content.number} missing Work Package`);
}

const milestones = await github(
  `/repos/${ORGANIZATION}/${REPOSITORY}/milestones?state=all&per_page=100`,
);
assert.equal(milestones.length, 10);
for (const milestone of milestones) {
  assert.equal(
    milestone.state,
    milestone.number <= 3 ? 'closed' : 'open',
    `milestone ${milestone.number} state`,
  );
  assert.ok(milestone.description?.trim(), `milestone ${milestone.number} description`);
  assert.ok(
    !milestone.description.includes('\\n'),
    `milestone ${milestone.number} has literal newline escapes`,
  );
}

assert.equal(source.findings.length, 58);
assert.equal(Object.values(coverage.groups).flatMap((group) => group.entries).length, 131);

console.log('Live Cotsel production-readiness setup is complete and reconciled.');
console.log(
  JSON.stringify(
    {
      project: `https://github.com/orgs/${ORGANIZATION}/projects/${PROJECT_NUMBER}`,
      programmeIssue: programme.url,
      primaryIssues: issues.length,
      workPackageParents: packages.workPackages.length,
      deliveryIssues: routes.issues.length,
      projectItems: project.items.totalCount,
      supportingIssues: expectedProjectNumbers.size - issues.length,
      findings: source.findings.length,
      supportingControls: Object.values(coverage.groups).flatMap((group) => group.entries).length,
      fields: project.fields.totalCount,
      views: project.views.totalCount,
      milestones: milestones.length,
      assignees: ['Astton', 'czpyioe'],
    },
    null,
    2,
  ),
);
