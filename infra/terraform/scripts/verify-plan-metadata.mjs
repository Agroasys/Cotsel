#!/usr/bin/env node

const EXPECTED = {
  action: 'plan',
  root: process.env.EXPECTED_ROOT,
  repository: process.env.EXPECTED_REPOSITORY,
  'workflow-path': '.github/workflows/terraform.yml',
  'run-id': process.env.EXPECTED_RUN_ID,
  'run-attempt': process.env.EXPECTED_RUN_ATTEMPT,
  'head-sha': process.env.EXPECTED_HEAD_SHA,
  ref: 'refs/heads/main',
  actor: process.env.EXPECTED_ACTOR,
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

for (const [name, value] of Object.entries(EXPECTED)) {
  if (!value) {
    console.error(`Expected value ${name} is missing.`);
    process.exit(2);
  }
}

let response;
try {
  response = JSON.parse(await readStdin());
} catch (error) {
  console.error(`S3 object metadata did not parse: ${error.message}`);
  process.exit(2);
}

const metadata = response.Metadata;
if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
  console.error('S3 object has no metadata map.');
  process.exit(1);
}

for (const [name, expected] of Object.entries(EXPECTED)) {
  const actual = metadata[name];
  if (actual !== expected) {
    console.error(`Plan metadata ${name} is '${actual ?? ''}', expected '${expected}'.`);
    process.exit(1);
  }
}

const digest = metadata['plan-sha256'];
if (!/^[0-9a-f]{64}$/.test(digest ?? '')) {
  console.error('Plan metadata does not contain a valid SHA-256 digest.');
  process.exit(1);
}

process.stdout.write(digest);
