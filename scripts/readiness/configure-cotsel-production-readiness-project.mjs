#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ORGANIZATION = process.env.READINESS_ORGANIZATION || 'Agroasys';
const REPOSITORY = process.env.READINESS_REPOSITORY || 'Cotsel';
const PROJECT_NUMBER = Number(process.env.READINESS_PROJECT_NUMBER || '9');
const TOKEN = process.env.READINESS_PROJECT_TOKEN || process.env.GH_TOKEN;
const APPLY = process.argv.includes('--apply');
if (!TOKEN) throw new Error('READINESS_PROJECT_TOKEN or GH_TOKEN is required.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'docs/readiness', name), 'utf8'));
const routes = read('cotsel-production-readiness-issue-route-contract.json');
const packages = read('cotsel-production-readiness-work-packages.json');

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

const fields = new Map(project.fields.nodes.filter(Boolean).map((field) => [field.name, field]));
const itemsByTitle = new Map();
const itemsByNumber = new Map();
for (const item of project.items.nodes) {
  if (item.content?.repository?.nameWithOwner !== `${ORGANIZATION}/${REPOSITORY}`) continue;
  itemsByTitle.set(item.content.title, item);
  itemsByNumber.set(item.content.number, item);
}

function titleForWp(wp) {
  return `[${wp.id}] ${wp.title}`;
}

const metadata = new Map();
metadata.set('[Programme] Cotsel production readiness and controlled-pilot authorization', {
  Status: 'Backlog',
  'Programme Track': 'Engineering Remediation',
  'Primary Gate': 'E-0',
  Priority: 'P0',
  'Work Type': 'Programme',
  'Delivery Surface': 'Programme/Governance',
  'SOW Class': 'Control',
  'SOW ID': 'Programme; 58 findings; 131 supporting controls',
  'Accountable Owner': 'Programme Lead',
  'Delivery Owner': 'Cotsel engineering leads',
  'Acceptance Owner': 'Engineering, Product, Finance, Operations, and launch authorities',
  'External Dependency': 'Yes',
  Risk: 'Critical',
  'Evidence Status': 'None',
});

const externallyDependentWps = new Set(['WP-0', 'WP-7', 'WP-9', 'WP-10', 'WP-11', 'WP-12']);
for (const wp of packages.workPackages) {
  metadata.set(titleForWp(wp), {
    Status: 'Backlog',
    'Work Package': wp.id,
    'Programme Track': wp.track,
    'Primary Gate': wp.gate,
    Priority: 'P0',
    'Work Type': 'Work Package',
    'Delivery Surface': 'Programme/Governance',
    'SOW Class': 'Control',
    'SOW ID': wp.id,
    'Accountable Owner': wp.owner,
    'Delivery Owner': 'Cotsel engineering and named delivery owners',
    'Acceptance Owner': `Named ${wp.gate} acceptance authority`,
    'External Dependency': externallyDependentWps.has(wp.id) ? 'Yes' : 'No',
    Risk: wp.risk,
    'Evidence Status': 'None',
  });
}

for (const route of routes.issues) {
  metadata.set(route.title, {
    Status:
      route.workType === 'Decision'
        ? 'Decision Required'
        : route.workType === 'Gate Review'
          ? 'Evidence Review'
          : 'Backlog',
    'Work Package': route.wp,
    'Programme Track': route.track,
    'Primary Gate': route.gate,
    Priority: route.priority,
    'Work Type': route.workType,
    'Delivery Surface': route.surface,
    'SOW Class': route.sowClass,
    'SOW ID': [...route.findingIds, ...route.controlIds].join(', '),
    'Accountable Owner': route.accountable,
    'Delivery Owner': route.delivery,
    'Acceptance Owner': route.acceptance,
    'External Dependency': route.external,
    Risk: route.risk,
    'Evidence Status': 'None',
  });
}

const supportingNumbers = [...new Set(routes.issues.flatMap((route) => route.supportingIssues))];
for (const number of supportingNumbers) {
  const route = routes.issues.find((candidate) => candidate.supportingIssues.includes(number));
  const item = itemsByNumber.get(number);
  if (!item)
    throw new Error(`Supporting issue #${number} is missing from Project ${PROJECT_NUMBER}.`);
  const labels = new Set(item.content.labels.nodes.map((label) => label.name));
  const status =
    item.content.state === 'CLOSED'
      ? 'In Review'
      : labels.has('status:blocked')
        ? 'Blocked'
        : labels.has('status:in-progress')
          ? 'In Progress'
          : 'Backlog';
  metadata.set(item.content.title, {
    Status: status,
    'Work Package': route.wp,
    'Programme Track': route.track,
    'Primary Gate': route.gate,
    Priority: route.priority,
    'Work Type': 'Implementation',
    'Delivery Surface': route.surface,
    'SOW Class': route.sowClass,
    'SOW ID': `Supporting issue #${number}; primary route ${route.key}`,
    'Accountable Owner': route.accountable,
    'Delivery Owner': route.delivery,
    'Acceptance Owner': route.acceptance,
    'External Dependency': route.external,
    Risk: route.risk,
    'Evidence Status': item.content.state === 'CLOSED' ? 'Partial' : 'None',
  });
}

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
for (const [title, values] of metadata) {
  const item = itemsByTitle.get(title);
  if (!item) throw new Error(`Project item is missing: ${title}`);
  for (const [fieldName, value] of Object.entries(values)) {
    operations.push({ item, fieldName, value, field: fields.get(fieldName) });
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
