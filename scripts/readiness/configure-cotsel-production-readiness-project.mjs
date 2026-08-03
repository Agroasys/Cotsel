#!/usr/bin/env node

import process from 'node:process';

import {
  expectedProjectFieldNames,
  expectedProjectSingleSelectOptions,
  mutableProjectFields,
  primaryProjectMetadata,
  supportingProjectMetadata,
} from './cotsel-production-readiness-project-metadata.mjs';

const ORGANIZATION = process.env.READINESS_ORGANIZATION || 'Agroasys';
const REPOSITORY = process.env.READINESS_REPOSITORY || 'Cotsel';
const PROJECT_NUMBER = Number(process.env.READINESS_PROJECT_NUMBER || '9');
const TOKEN = process.env.READINESS_PROJECT_TOKEN || process.env.GH_TOKEN;
const APPLY = process.argv.includes('--apply');
if (!TOKEN) throw new Error('READINESS_PROJECT_TOKEN or GH_TOKEN is required.');

async function graphql(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'agroasys-cotsel-readiness-project-configurator',
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

const data = await graphql(
  `
    query ($organization: String!, $repository: String!, $number: Int!) {
      organization(login: $organization) {
        projectV2(number: $number) {
          id
          title
          fields(first: 100) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
            }
          }
          items(first: 100) {
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
                  url
                  repository {
                    nameWithOwner
                  }
                  labels(first: 40) {
                    nodes {
                      name
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
        id
      }
    }
  `,
  { organization: ORGANIZATION, repository: REPOSITORY, number: PROJECT_NUMBER },
);
const project = data.organization?.projectV2;
if (!project) throw new Error(`Project ${ORGANIZATION}/${PROJECT_NUMBER} not found.`);

let itemCursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
while (itemCursor) {
  const pageData = await graphql(
    `
      query ($projectId: ID!, $cursor: String!) {
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
                    url
                    repository {
                      nameWithOwner
                    }
                    labels(first: 40) {
                      nodes {
                        name
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
      }
    `,
    { projectId: project.id, cursor: itemCursor },
  );
  const page = pageData.node.items;
  project.items.nodes.push(...page.nodes);
  itemCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
}

const fields = new Map(project.fields.nodes.filter(Boolean).map((field) => [field.name, field]));
const liveFieldNames = [...fields.keys()].sort();
const expectedFieldNames = [...expectedProjectFieldNames].sort();
if (JSON.stringify(liveFieldNames) !== JSON.stringify(expectedFieldNames)) {
  throw new Error(
    `Project field contract mismatch. Expected ${JSON.stringify(expectedFieldNames)}, received ${JSON.stringify(liveFieldNames)}.`,
  );
}
for (const [fieldName, expectedOptions] of Object.entries(expectedProjectSingleSelectOptions)) {
  const field = fields.get(fieldName);
  if (!field?.options) throw new Error(`Project field is not single-select: ${fieldName}`);
  const actualOptions = field.options.map((option) => option.name);
  if (JSON.stringify(actualOptions) !== JSON.stringify(expectedOptions)) {
    throw new Error(
      `Project option contract mismatch for ${fieldName}. Expected ${JSON.stringify(expectedOptions)}, received ${JSON.stringify(actualOptions)}.`,
    );
  }
}
const itemsByTitle = new Map();
const itemsByNumber = new Map();
for (const item of project.items.nodes) {
  if (item.content?.repository?.nameWithOwner !== `${ORGANIZATION}/${REPOSITORY}`) continue;
  itemsByTitle.set(item.content.title, item);
  itemsByNumber.set(item.content.number, item);
}

const metadata = primaryProjectMetadata();
const supportingMetadata = supportingProjectMetadata(
  new Map([...itemsByNumber].map(([number, item]) => [number, item.content])),
);
for (const [title, values] of supportingMetadata) metadata.set(title, values);

function fieldValue(fieldName, value) {
  const field = fields.get(fieldName);
  if (!field) throw new Error(`Missing Project field: ${fieldName}`);
  if (field.options) {
    const option = field.options.find((candidate) => candidate.name === value);
    if (!option) throw new Error(`Missing Project option: ${fieldName}=${value}`);
    return `{singleSelectOptionId:${JSON.stringify(option.id)}}`;
  }
  return `{text:${JSON.stringify(String(value))}}`;
}

const operations = [];
const mutableProgressFields = new Set(mutableProjectFields);
for (const [title, values] of metadata) {
  const item = itemsByTitle.get(title);
  if (!item) throw new Error(`Project item is missing: ${title}`);
  const existingValues = new Map(
    item.fieldValues.nodes
      .filter((value) => value.field?.name)
      .map((value) => [value.field.name, value.name ?? value.text]),
  );
  for (const [fieldName, value] of Object.entries(values)) {
    const field = fields.get(fieldName);
    if (!field) throw new Error(`Missing Project field: ${fieldName}`);
    if (field.options && !field.options.some((option) => option.name === value)) {
      throw new Error(`Missing Project option: ${fieldName}=${value}`);
    }
    const existingValue = existingValues.get(fieldName);
    if (mutableProgressFields.has(fieldName) && existingValue) continue;
    if (existingValue === String(value)) continue;
    operations.push({ item, fieldName, value, field });
  }
}

if (!APPLY) {
  console.log(`Dry run: ${operations.length} field values across ${metadata.size} Project items.`);
  process.exit(0);
}

for (let offset = 0; offset < operations.length; offset += 15) {
  const batch = operations.slice(offset, offset + 15);
  const mutations = batch.map((operation, index) => {
    const value = fieldValue(operation.fieldName, operation.value);
    return `m${index}: updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(project.id)},itemId:${JSON.stringify(operation.item.id)},fieldId:${JSON.stringify(operation.field.id)},value:${value}}){projectV2Item{id}}`;
  });
  await graphql(`mutation { ${mutations.join('\n')} }`);
  console.log(
    `Applied ${Math.min(offset + batch.length, operations.length)}/${operations.length} field values.`,
  );
}

console.log(`Configured ${metadata.size} Cotsel readiness items in ${project.title}.`);
