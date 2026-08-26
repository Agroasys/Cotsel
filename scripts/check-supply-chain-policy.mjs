import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const supportedNodeVersion = '22.23.2';

const sha256Pattern = /@sha256:[a-f0-9]{64}(?:\s|$)/u;
const actionShaPattern = /^[a-f0-9]{40}$/u;

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) {
      return [];
    }
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

export function workflowViolations(path, contents) {
  const violations = [];

  for (const [index, line] of contents.split('\n').entries()) {
    const action = line.match(/^\s*uses:\s*([^\s#]+)/u)?.[1];
    if (action && !action.startsWith('./')) {
      const reference = action.slice(action.lastIndexOf('@') + 1);
      if (!actionShaPattern.test(reference)) {
        violations.push(`${path}:${index + 1}: action must use a 40-character commit SHA`);
      }
    }

    const nodeVersion = line.match(/^\s*node-version:\s*['"]?([^'"\s]+)['"]?/u)?.[1];
    if (nodeVersion && nodeVersion !== supportedNodeVersion) {
      violations.push(
        `${path}:${index + 1}: node-version must be ${supportedNodeVersion}, found ${nodeVersion}`,
      );
    }

    const image = line.match(/^\s*image:\s*([^\s#]+)/u)?.[1];
    if (image && !image.includes('${{') && !sha256Pattern.test(image)) {
      violations.push(`${path}:${index + 1}: workflow service image must be digest-pinned`);
    }
  }

  return violations;
}

export function dockerfileViolations(path, contents) {
  const violations = [];

  for (const [index, line] of contents.split('\n').entries()) {
    const image = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/u)?.[1];
    if (image && image !== 'scratch' && !sha256Pattern.test(image)) {
      violations.push(`${path}:${index + 1}: Docker base image must be digest-pinned`);
    }
  }

  return violations;
}

export function composeViolations(path, contents) {
  const violations = [];

  for (const [index, line] of contents.split('\n').entries()) {
    const image = line.match(/^\s*image:\s*([^\s#]+)/u)?.[1];
    if (image && !image.includes('${') && !sha256Pattern.test(image)) {
      violations.push(`${path}:${index + 1}: Compose image must be digest-pinned`);
    }
  }

  return violations;
}

export function releaseWorkflowViolations(contents) {
  const requiredControls = [
    ['artifact-metadata: write', 'artifact metadata permission'],
    ['attestations: write', 'attestation permission'],
    ['provenance: mode=max', 'BuildKit provenance'],
    ['sbom: true', 'BuildKit SBOM'],
    ['format: spdx-json', 'SPDX SBOM generation'],
    ['uses: actions/attest@', 'signed GitHub attestation'],
    ['gh attestation verify', 'signed attestation verification'],
  ];

  return requiredControls.flatMap(([needle, label]) =>
    contents.includes(needle) ? [] : [`release-images.yml: missing ${label}`],
  );
}

export function repositoryViolations(root) {
  const violations = [];
  const workflowDirectory = join(root, '.github', 'workflows');

  for (const path of filesBelow(workflowDirectory).filter((file) => /\.ya?ml$/u.test(file))) {
    violations.push(...workflowViolations(relative(root, path), readFileSync(path, 'utf8')));
  }

  for (const path of filesBelow(root).filter((file) => basename(file) === 'Dockerfile')) {
    if (path.includes(`${join(root, 'node_modules')}/`)) {
      continue;
    }
    violations.push(...dockerfileViolations(relative(root, path), readFileSync(path, 'utf8')));
  }

  const composePaths = [
    join(root, 'docker-compose.services.yml'),
    join(root, 'indexer', 'docker-compose.yml'),
    join(root, 'oracle', 'docker-compose.yml'),
  ];
  for (const path of composePaths) {
    violations.push(...composeViolations(relative(root, path), readFileSync(path, 'utf8')));
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (packageJson.engines?.node !== '>=22 <23') {
    violations.push('package.json: engines.node must be >=22 <23');
  }

  const nvmVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (nvmVersion !== supportedNodeVersion) {
    violations.push(`.nvmrc: expected ${supportedNodeVersion}, found ${nvmVersion}`);
  }

  const releaseWorkflow = readFileSync(join(workflowDirectory, 'release-images.yml'), 'utf8');
  violations.push(...releaseWorkflowViolations(releaseWorkflow));

  const indexerDockerfile = readFileSync(join(root, 'indexer', 'Dockerfile'), 'utf8');
  if (!/^USER agro$/mu.test(indexerDockerfile)) {
    violations.push('indexer/Dockerfile: runtime must use USER agro');
  }

  return violations;
}

function run() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const violations = repositoryViolations(root);
  if (violations.length > 0) {
    console.error('Supply-chain policy failed:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Supply-chain policy passed for Node ${supportedNodeVersion}.`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  run();
}
