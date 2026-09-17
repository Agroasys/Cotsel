import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

const dependabotConfig = () =>
  readFile(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');

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
  assert.match(contents, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('groups only minor and patch Dependabot version updates', async () => {
  const contents = await dependabotConfig();
  const runtime = contents.slice(
    contents.indexOf('      npm-runtime:'),
    contents.indexOf('      npm-dev:'),
  );
  const development = contents.slice(
    contents.indexOf('      npm-dev:'),
    contents.indexOf('\n\n  - package-ecosystem: github-actions'),
  );

  for (const group of [runtime, development]) {
    assert.match(group, /applies-to: version-updates/);
    assert.match(group, /update-types:\n\s+- minor\n\s+- patch/);
    assert.doesNotMatch(group, /- major/);
  }

  assert.match(runtime, /exclude-patterns:\n\s+- 'ox'/);
});

test('keeps authenticated cross-repository checks for people and a credential-free gate for Dependabot', async () => {
  const contents = await workflow('cross-repository-compatibility.yml');

  assert.match(contents, /CI_APP_PRIVATE_KEY:[\s\S]*?required: false/);
  assert.match(contents, /compatibility:[\s\S]*?if: github\.actor != 'dependabot\[bot\]'/);
  assert.match(
    contents,
    /dependabot-compatibility:[\s\S]*?if: github\.actor == 'dependabot\[bot\]'/,
  );
  assert.match(
    contents,
    /dependabot-compatibility:[\s\S]*?node scripts\/check-cross-repo-release-manifest\.mjs/,
  );
  assert.match(contents, /dependabot-compatibility:[\s\S]*?pnpm install --frozen-lockfile/);
  assert.match(contents, /dependabot-compatibility:[\s\S]*?pnpm run security:deps:compat/);
});
