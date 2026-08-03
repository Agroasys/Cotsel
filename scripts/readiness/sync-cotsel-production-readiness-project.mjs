#!/usr/bin/env node

const ORGANIZATION = process.env.READINESS_ORGANIZATION || 'Agroasys';
const REPOSITORY = process.env.READINESS_REPOSITORY || 'Cotsel';
const PROJECT_NUMBER = Number(process.env.READINESS_PROJECT_NUMBER || '9');
const REQUIRED_LABEL =
  process.env.READINESS_PROGRAMME_LABEL || 'programme:cotsel-production-readiness';
const TOKEN = process.env.READINESS_PROJECT_TOKEN || process.env.GH_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

if (!TOKEN) {
  console.error(
    'READINESS_PROJECT_TOKEN is required with Cotsel issue read and organization Project write access.',
  );
  process.exit(2);
}

async function graphql(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'agroasys-cotsel-readiness-project-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL request failed: ${response.status} ${JSON.stringify(payload.errors || payload)}`,
    );
  }
  return payload.data;
}

async function loadProject() {
  const data = await graphql(
    `
      query ($organization: String!, $number: Int!) {
        organization(login: $organization) {
          projectV2(number: $number) {
            id
            title
            fields(first: 100) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `,
    { organization: ORGANIZATION, number: PROJECT_NUMBER },
  );
  const project = data.organization?.projectV2;
  if (!project)
    throw new Error(`Project ${ORGANIZATION}/${PROJECT_NUMBER} is not visible to the token.`);
  return project;
}

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
                      url
                    }
                  }
                  fieldValues(first: 40) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
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

async function loadIssues() {
  const issues = [];
  let cursor = null;
  do {
    const data = await graphql(
      `
        query ($organization: String!, $repository: String!, $label: String!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            issues(
              first: 100
              after: $cursor
              states: OPEN
              labels: [$label]
              orderBy: { field: CREATED_AT, direction: ASC }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                number
                title
                url
                labels(first: 40) {
                  nodes {
                    name
                  }
                }
              }
            }
          }
        }
      `,
      { organization: ORGANIZATION, repository: REPOSITORY, label: REQUIRED_LABEL, cursor },
    );
    if (!data.repository)
      throw new Error(`Repository ${ORGANIZATION}/${REPOSITORY} is not visible to the token.`);
    issues.push(...data.repository.issues.nodes);
    cursor = data.repository.issues.pageInfo.hasNextPage
      ? data.repository.issues.pageInfo.endCursor
      : null;
  } while (cursor);
  return issues;
}

const labelsOf = (issue) => new Set(issue.labels.nodes.map((label) => label.name.toLowerCase()));
const inferWp = (issue) =>
  issue.title.match(/\bWP[- ]?(\d{1,2})\b/i)?.[1]
    ? `WP-${issue.title.match(/\bWP[- ]?(\d{1,2})\b/i)[1]}`
    : null;
function inferType(issue) {
  const labels = labelsOf(issue);
  if (labels.has('type:programme')) return 'Programme';
  if (labels.has('type:work-package')) return 'Work Package';
  if (labels.has('type:decision')) return 'Decision';
  if (labels.has('type:external-dependency')) return 'External Dependency';
  if (labels.has('type:gate-review')) return 'Gate Review';
  if (labels.has('type:defect') || labels.has('bug')) return 'Defect';
  if (labels.has('type:evidence')) return 'Evidence';
  return 'Implementation';
}
function inferStatus(issue) {
  const labels = labelsOf(issue);
  const mappings = [
    ['status:accepted', 'Accepted'],
    ['status:evidence-review', 'Evidence Review'],
    ['status:in-review', 'In Review'],
    ['status:blocked', 'Blocked'],
    ['status:in-progress', 'In Progress'],
    ['status:ready', 'Ready'],
    ['status:decision-required', 'Decision Required'],
  ];
  return mappings.find(([label]) => labels.has(label))?.[1] || 'Backlog';
}

function option(fields, fieldName, optionName) {
  const field = fields.find((item) => item?.name === fieldName);
  const selected = field?.options?.find((item) => item.name === optionName);
  if (!field || !selected) throw new Error(`Missing Project option ${fieldName}=${optionName}`);
  return { fieldId: field.id, optionId: selected.id };
}

async function addItem(projectId, contentId) {
  const data = await graphql(
    `
      mutation ($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `,
    { projectId, contentId },
  );
  return data.addProjectV2ItemById.item;
}

async function setSelect(projectId, itemId, fieldId, optionId) {
  await graphql(
    `
      mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    { projectId, itemId, fieldId, optionId },
  );
}

function selectedValue(item, fieldName) {
  return item.fieldValues?.nodes.find((value) => value.field?.name === fieldName)?.name;
}

const project = await loadProject();
const issues = await loadIssues();
const projectItems = await loadProjectItems(project.id);
const existing = new Map(projectItems.map((item) => [item.content.id, item]));
const actions = [];

for (const issue of issues) {
  let item = existing.get(issue.id);
  if (!item) {
    actions.push(`add ${issue.url}`);
    if (!DRY_RUN) {
      item = await addItem(project.id, issue.id);
      item.fieldValues = { nodes: [] };
    }
  }
  const values = [
    ['Status', inferStatus(issue)],
    ['Work Type', inferType(issue)],
    ['Work Package', inferWp(issue)],
  ].filter(([, value]) => value);
  for (const [fieldName, optionName] of values) {
    if (selectedValue(item, fieldName)) continue;
    actions.push(`set ${issue.url} ${fieldName}=${optionName}`);
    if (!DRY_RUN) {
      const ids = option(project.fields.nodes, fieldName, optionName);
      await setSelect(project.id, item.id, ids.fieldId, ids.optionId);
    }
  }
}

console.log(
  `${DRY_RUN ? 'Dry run' : 'Applied'} ${actions.length} actions for ${issues.length} open programme issues in ${project.title}.`,
);
for (const action of actions) console.log(action);
