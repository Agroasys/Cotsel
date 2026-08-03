#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import process from 'node:process';

import {
  controls,
  milestones as milestoneContract,
  packages,
  programmeTitle,
  routes,
  source,
  supportingIssues,
  titleForWorkPackage,
} from './cotsel-production-readiness-model.mjs';
import {
  expectedProjectFieldNames,
  expectedProjectSingleSelectOptions,
  invariantProjectFields,
  primaryProjectMetadata,
  supportingProjectMetadata,
} from './cotsel-production-readiness-project-metadata.mjs';
import { renderBodyForTitle } from './render-cotsel-production-readiness-issue.mjs';

const ORGANIZATION = process.env.READINESS_ORGANIZATION || 'Agroasys';
const REPOSITORY = process.env.READINESS_REPOSITORY || 'Cotsel';
const PROJECT_NUMBER = Number(process.env.READINESS_PROJECT_NUMBER || '9');
const TOKEN = process.env.READINESS_PROJECT_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) throw new Error('READINESS_PROJECT_TOKEN or GH_TOKEN is required for the live audit.');

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
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function graphql(query, variables = {}) {
  const payload = await github('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors)}`);
  }
  return payload.data;
}

const staticData = await graphql(
  `
    query ($organization: String!, $projectNumber: Int!) {
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
              ... on ProjectV2SingleSelectField {
                options {
                  name
                }
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
          items(first: 1) {
            totalCount
          }
        }
      }
    }
  `,
  { organization: ORGANIZATION, projectNumber: PROJECT_NUMBER },
);

const project = staticData.organization?.projectV2;
assert.ok(project, `Project ${ORGANIZATION}/${PROJECT_NUMBER} exists`);

async function loadProjectItems(projectId) {
  const items = [];
  let cursor = null;
  do {
    const data = await graphql(
      `
        query ($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                      number
                      title
                      state
                      repository {
                        nameWithOwner
                      }
                      labels(first: 40) {
                        nodes {
                          name
                        }
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
                      ... on ProjectV2ItemFieldDateValue {
                        date
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
        }
      `,
      { projectId, cursor },
    );
    const page = data.node.items;
    items.push(...page.nodes.filter((item) => item.content?.id));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

async function loadProgrammeIssues() {
  const issues = [];
  let cursor = null;
  let totalCount = null;
  do {
    const data = await graphql(
      `
        query ($organization: String!, $repository: String!, $label: String!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            issues(
              first: 100
              after: $cursor
              states: [OPEN, CLOSED]
              labels: [$label]
              orderBy: { field: CREATED_AT, direction: ASC }
            ) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                number
                title
                body
                state
                url
                labels(first: 40) {
                  nodes {
                    name
                  }
                }
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
        label: 'programme:cotsel-production-readiness',
        cursor,
      },
    );
    const page = data.repository.issues;
    totalCount ??= page.totalCount;
    issues.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  assert.equal(issues.length, totalCount, 'programme issue pagination is complete');
  return issues;
}

const [issues, projectItems] = await Promise.all([
  loadProgrammeIssues(),
  loadProjectItems(project.id),
]);

assert.equal(project.title, 'Cotsel Production Readiness and Controlled Pilot');
assert.equal(project.public, true);
assert.equal(project.closed, false);
assert.deepEqual(
  project.repositories.nodes.map((item) => item.nameWithOwner),
  ['Agroasys/Cotsel'],
);

const expectedPrimaryIssueCount = 1 + packages.workPackages.length + routes.issues.length;
assert.equal(issues.length, expectedPrimaryIssueCount, 'managed programme issue count');
const byTitle = new Map(issues.map((issue) => [issue.title, issue]));
const programme = byTitle.get(programmeTitle);
assert.ok(programme, 'programme issue exists');
const expectedTitles = [
  programmeTitle,
  ...packages.workPackages.map(titleForWorkPackage),
  ...routes.issues.map((route) => route.title),
];
assert.equal(new Set(expectedTitles).size, expectedPrimaryIssueCount);
assert.deepEqual([...byTitle.keys()].sort(), [...expectedTitles].sort(), 'managed issue titles');

function normalizeBody(body) {
  return String(body).replaceAll('\r\n', '\n').trimEnd();
}

function bodyMismatchMessage(issue, expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const index = Array.from(
    { length: Math.max(expectedLines.length, actualLines.length) },
    (_, line) => line,
  ).find((line) => expectedLines[line] !== actualLines[line]);
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  return [
    `#${issue.number} body differs at line ${(index ?? 0) + 1}`,
    `expected sha256 ${digest(expected)}`,
    `actual sha256 ${digest(actual)}`,
    `expected: ${expectedLines[index] ?? '<EOF>'}`,
    `actual: ${actualLines[index] ?? '<EOF>'}`,
  ].join('\n');
}

for (const issue of issues) {
  assert.deepEqual(
    issue.assignees.nodes.map((item) => item.login).sort(),
    ['Astton', 'czpyioe'],
    `assignees for #${issue.number}`,
  );
  assert.ok(issue.milestone?.title, `milestone missing from #${issue.number}`);
  const expected = normalizeBody(renderBodyForTitle(issue.title));
  const actual = normalizeBody(issue.body);
  assert.ok(expected === actual, bodyMismatchMessage(issue, expected, actual));
}

assert.equal(programme.parent, null);
assert.equal(programme.milestone.title, 'M0 Base Migration Decision and Boundary Freeze');
assert.equal(programme.subIssues.totalCount, packages.workPackages.length);
for (const workPackage of packages.workPackages) {
  const parentTitle = titleForWorkPackage(workPackage);
  const parent = byTitle.get(parentTitle);
  const children = routes.issues.filter((route) => route.wp === workPackage.id);
  assert.equal(parent.parent.number, programme.number, `${workPackage.id} parent link`);
  assert.equal(parent.milestone.title, workPackage.milestone, `${workPackage.id} milestone`);
  assert.equal(parent.subIssues.totalCount, children.length, `${workPackage.id} child count`);
  assert.deepEqual(
    parent.subIssues.nodes.map((item) => item.title).sort(),
    children.map((item) => item.title).sort(),
    `${workPackage.id} child titles`,
  );
  for (const route of children) {
    const child = byTitle.get(route.title);
    assert.equal(child.parent.number, parent.number, `${route.key} parent link`);
    assert.equal(child.milestone.title, route.milestone, `${route.key} milestone`);
  }
}

const projectFields = project.fields.nodes.filter(Boolean);
const fieldNames = projectFields.map((field) => field.name);
assert.deepEqual([...fieldNames].sort(), [...expectedProjectFieldNames].sort(), 'Project fields');
assert.ok(!fieldNames.some((name) => /percent|%\s*complete/i.test(name)));
const projectFieldByName = new Map(projectFields.map((field) => [field.name, field]));
for (const [fieldName, options] of Object.entries(expectedProjectSingleSelectOptions)) {
  assert.deepEqual(
    projectFieldByName.get(fieldName)?.options?.map((option) => option.name),
    options,
    `Project options: ${fieldName}`,
  );
}

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
for (const view of project.views.nodes) {
  assert.deepEqual([view.layout, view.filter], expectedViews.get(view.name), `view ${view.name}`);
}

const expectedProjectNumbers = new Set([
  ...issues.map((issue) => issue.number),
  ...supportingIssues.issues.map((issue) => issue.number),
]);
assert.equal(project.items.totalCount, expectedProjectNumbers.size);
const cotselProjectItems = projectItems.filter(
  (item) => item.content.repository.nameWithOwner === 'Agroasys/Cotsel',
);
assert.deepEqual(
  cotselProjectItems.map((item) => item.content.number).sort((a, b) => a - b),
  [...expectedProjectNumbers].sort((a, b) => a - b),
  'Project contains exact managed and supporting issue set',
);
for (const item of cotselProjectItems) {
  assert.deepEqual(
    item.content.assignees.nodes.map((assignee) => assignee.login).sort(),
    ['Astton', 'czpyioe'],
    `Project item #${item.content.number} assignees`,
  );
}

const allProjectIssueByNumber = new Map(
  cotselProjectItems.map((item) => [item.content.number, item.content]),
);
const expectedMetadata = primaryProjectMetadata();
for (const [title, metadata] of supportingProjectMetadata(allProjectIssueByNumber)) {
  expectedMetadata.set(title, metadata);
}
const projectItemByTitle = new Map(cotselProjectItems.map((item) => [item.content.title, item]));
for (const [title, expected] of expectedMetadata) {
  const item = projectItemByTitle.get(title);
  assert.ok(item, `Project item missing: ${title}`);
  const values = new Map(
    item.fieldValues.nodes
      .filter((value) => value.field?.name)
      .map((value) => [value.field.name, value.name ?? value.text ?? value.date]),
  );
  for (const field of invariantProjectFields) {
    assert.equal(values.get(field), expected[field], `${title}: ${field}`);
  }
  if (expected['Work Package']) {
    assert.equal(values.get('Work Package'), expected['Work Package'], `${title}: Work Package`);
  } else {
    assert.ok(!values.get('Work Package'), `${title}: unexpected Work Package`);
  }
  assert.ok(values.get('Status'), `${title}: Status`);
  assert.ok(values.get('Evidence Status'), `${title}: Evidence Status`);
}

const liveMilestones = await github(
  `/repos/${ORGANIZATION}/${REPOSITORY}/milestones?state=all&per_page=100`,
);
const normalizedMilestones = liveMilestones
  .map((item) => ({
    number: item.number,
    title: item.title,
    state: item.state,
    description: item.description,
  }))
  .sort((a, b) => a.number - b.number);
assert.deepEqual(normalizedMilestones, milestoneContract.milestones, 'milestone contract');

assert.equal(source.findings.length, 58);
assert.equal(controls.length, 136);

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
      supportingIssues: supportingIssues.issues.length,
      findings: source.findings.length,
      supportingControls: controls.length,
      fields: project.fields.totalCount,
      views: project.views.totalCount,
      milestones: liveMilestones.length,
      assignees: ['Astton', 'czpyioe'],
      bodyVerification: 'full deterministic body comparison',
      milestoneVerification: 'exact title, state, and description comparison',
    },
    null,
    2,
  ),
);
