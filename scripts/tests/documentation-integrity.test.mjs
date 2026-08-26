import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const serviceReadmes = [
  'auth/README.md',
  'contracts/README.md',
  'indexer/README.md',
  'notifications/README.md',
  'oracle/README.md',
  'reconciliation/README.md',
  'ricardian/README.md',
  'sdk/README.md',
  'treasury/README.md',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entryPath === path.join(repositoryRoot, 'docs', 'readiness')) {
        return [];
      }
      return markdownFiles(entryPath);
    }
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.includes('closeout')) {
      return [];
    }
    return [entryPath];
  });
}

function linkDestination(rawLink) {
  const trimmed = rawLink.trim();
  if (trimmed.startsWith('<')) {
    return trimmed.slice(1, trimmed.indexOf('>'));
  }
  return trimmed.split(/\s+/u)[0];
}

function isExternalOrDocumentAnchor(destination) {
  return (
    destination.startsWith('#') ||
    destination.startsWith('/') ||
    destination.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(destination)
  );
}

test('active documentation has no broken repository-local Markdown links', () => {
  const files = [
    path.join(repositoryRoot, 'README.md'),
    path.join(repositoryRoot, 'CONTRIBUTING.md'),
    ...serviceReadmes.map((file) => path.join(repositoryRoot, file)),
    ...markdownFiles(path.join(repositoryRoot, 'docs')),
  ];
  const brokenLinks = [];

  for (const file of files) {
    const markdown = fs.readFileSync(file, 'utf8');
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/gu)) {
      const destination = linkDestination(match[1]);
      if (!destination || isExternalOrDocumentAnchor(destination)) {
        continue;
      }
      const relativeTarget = decodeURIComponent(destination.split('#')[0].split('?')[0]);
      const target = path.resolve(path.dirname(file), relativeTarget);
      if (!fs.existsSync(target)) {
        brokenLinks.push(
          `${path.relative(repositoryRoot, file)} -> ${destination} (line ${markdown.slice(0, match.index).split('\n').length})`,
        );
      }
    }
  }

  assert.deepEqual(brokenLinks, []);
});

test('documented pnpm scripts and supported toolchain match package manifests', () => {
  const rootManifest = readJson(path.join(repositoryRoot, 'package.json'));
  const contributing = fs.readFileSync(path.join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8');
  const supportedNodeVersion = fs.readFileSync(path.join(repositoryRoot, '.nvmrc'), 'utf8').trim();
  assert.ok(contributing.includes(`Node.js ${supportedNodeVersion}`));
  assert.ok(contributing.includes(rootManifest.packageManager.replace('@', ' ')));

  const documents = [
    [path.join(repositoryRoot, 'CONTRIBUTING.md'), rootManifest],
    [path.join(repositoryRoot, 'README.md'), rootManifest],
    ...markdownFiles(path.join(repositoryRoot, 'docs')).map((file) => [file, rootManifest]),
    ...serviceReadmes.map((file) => [
      path.join(repositoryRoot, file),
      readJson(path.join(repositoryRoot, path.dirname(file), 'package.json')),
    ]),
  ];
  const invalidCommands = [];

  for (const [file, manifest] of documents) {
    const markdown = fs.readFileSync(file, 'utf8');
    for (const match of markdown.matchAll(/\bpnpm run ([a-z0-9:-]+)/giu)) {
      if (!manifest.scripts?.[match[1]]) {
        invalidCommands.push(`${path.relative(repositoryRoot, file)}: pnpm run ${match[1]}`);
      }
    }
    for (const match of markdown.matchAll(/\bpnpm --filter \.\/([^\s`]+) run ([a-z0-9:-]+)/giu)) {
      const workspaceManifestPath = path.join(repositoryRoot, match[1], 'package.json');
      const workspaceManifest = fs.existsSync(workspaceManifestPath)
        ? readJson(workspaceManifestPath)
        : null;
      if (!workspaceManifest?.scripts?.[match[2]]) {
        invalidCommands.push(
          `${path.relative(repositoryRoot, file)}: pnpm --filter ./${match[1]} run ${match[2]}`,
        );
      }
    }
  }

  assert.deepEqual(invalidCommands, []);
});

test('active runbooks do not present unimplemented gateway governance as executable', () => {
  const gatewayManifest = readJson(path.join(repositoryRoot, 'gateway/package.json'));
  assert.equal(gatewayManifest.scripts?.['execute:governance-action'], undefined);

  const operations = fs.readFileSync(
    path.join(repositoryRoot, 'docs/runbooks/dashboard-gateway-operations.md'),
    'utf8',
  );
  const custody = fs.readFileSync(
    path.join(repositoryRoot, 'docs/runbooks/gateway-governance-signer-custody.md'),
    'utf8',
  );
  assert.match(operations, /\*\*BLOCKED \/ NOT IMPLEMENTED\.\*\*/u);
  assert.match(custody, /\*\*BLOCKED \/ NOT IMPLEMENTED\.\*\*/u);
  assert.doesNotMatch(operations, /pnpm --filter \.\/gateway run execute:governance-action/u);
  assert.doesNotMatch(operations, /gateway\/scripts\/governance-cleanup\.mjs/u);
});

test('VM deployment guidance cannot be mistaken for the AWS staging release path', () => {
  const vmRunbook = fs.readFileSync(
    path.join(repositoryRoot, 'docs/runbooks/vm-deploy.md'),
    'utf8',
  );
  assert.match(vmRunbook, /\*\*STALE \/ LEGACY for shared staging\.\*\*/u);
  assert.match(vmRunbook, /reviewed Terraform, immutable images, and ECS task definitions/u);
});
