import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

test('uses events first and only one daily governance reconciliation', async () => {
  const contents = await workflow('cotsel-production-readiness-project-governance.yml');

  assert.match(contents, /issues:\n\s+types: \[opened, reopened, labeled\]/);
  assert.match(contents, /workflow_dispatch:/);
  assert.match(contents, /cron: '41 2 \* \* \*'/);
  assert.doesNotMatch(contents, /\*\/6/);
});

test('cancels only superseded work for the same pull request', async () => {
  for (const name of ['dco.yml', 'pr-roadmap-policy.yml']) {
    const contents = await workflow(name);
    assert.match(
      contents,
      /group: .+\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
      `${name} must isolate concurrency by workflow and pull request`,
    );
    assert.match(contents, /cancel-in-progress: true/);
  }
});

test('preserves default-branch release-gate work', async () => {
  const contents = await workflow('release-gate.yml');

  assert.match(
    contents,
    /group: .+\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
  );
  assert.match(
    contents,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
});
