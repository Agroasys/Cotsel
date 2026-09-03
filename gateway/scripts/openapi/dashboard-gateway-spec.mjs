/**
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const sourceDirectory = path.join(repositoryRoot, 'docs/api/cotsel-dashboard-gateway');
const manifestPath = path.join(sourceDirectory, 'manifest.json');
const indexPath = path.join(repositoryRoot, 'docs/api/cotsel-dashboard-gateway.openapi.yml');
const bundlePath = path.join(
  repositoryRoot,
  'gateway/.generated/openapi/cotsel-dashboard-gateway.openapi.yml',
);

function readYaml(relativePath) {
  const absolutePath = path.join(sourceDirectory, relativePath);
  const parsed = yaml.load(fs.readFileSync(absolutePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenAPI source fragment must contain a mapping: ${relativePath}`);
  }
  return parsed;
}

function readManifest() {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    parsed?.version !== 1 ||
    typeof parsed.root !== 'string' ||
    !Array.isArray(parsed.paths) ||
    !Array.isArray(parsed.components)
  ) {
    throw new Error('Dashboard gateway OpenAPI manifest is invalid');
  }
  return parsed;
}

function mergeUnique(target, incoming, sourceName, sectionName) {
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(target, key)) {
      throw new Error(`Duplicate ${sectionName} key ${key} in ${sourceName}`);
    }
    target[key] = value;
  }
}

function loadDashboardGatewaySpecParts() {
  const manifest = readManifest();
  const root = readYaml(manifest.root);
  if ('paths' in root || 'components' in root) {
    throw new Error('Root fragment must not define paths or components');
  }

  const paths = {};
  const pathSources = {};
  for (const relativePath of manifest.paths) {
    const fragment = readYaml(relativePath);
    const fragmentPaths = fragment.paths;
    if (!fragmentPaths || typeof fragmentPaths !== 'object' || Array.isArray(fragmentPaths)) {
      throw new Error(`Path fragment must define a paths mapping: ${relativePath}`);
    }
    mergeUnique(paths, fragmentPaths, relativePath, 'path');
    for (const key of Object.keys(fragmentPaths)) pathSources[key] = relativePath;
  }

  const components = {};
  const componentSources = {};
  for (const relativePath of manifest.components) {
    const fragment = readYaml(relativePath);
    const fragmentComponents = fragment.components;
    if (
      !fragmentComponents ||
      typeof fragmentComponents !== 'object' ||
      Array.isArray(fragmentComponents)
    ) {
      throw new Error(`Component fragment must define components: ${relativePath}`);
    }
    for (const [sectionName, section] of Object.entries(fragmentComponents)) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw new Error(`Component section ${sectionName} must be a mapping in ${relativePath}`);
      }
      const targetSection = (components[sectionName] ??= {});
      mergeUnique(targetSection, section, relativePath, `component ${sectionName}`);
      const sourceSection = (componentSources[sectionName] ??= {});
      for (const key of Object.keys(section)) sourceSection[key] = relativePath;
    }
  }

  if (Object.keys(paths).length === 0 || Object.keys(components.schemas ?? {}).length === 0) {
    throw new Error('Assembled dashboard gateway specification is incomplete');
  }

  return { root, paths, pathSources, components, componentSources };
}

export function assembleDashboardGatewaySpec() {
  const { root, paths, components } = loadDashboardGatewaySpecParts();
  return { ...root, paths, components };
}

export function renderDashboardGatewaySpec() {
  const spec = assembleDashboardGatewaySpec();
  const body = yaml.dump(spec, {
    lineWidth: -1,
    noRefs: true,
    noCompatMode: true,
    sortKeys: false,
  });
  return [
    '# GENERATED FILE. DO NOT EDIT DIRECTLY.',
    '# Source: docs/api/cotsel-dashboard-gateway/manifest.json',
    '# Regenerate: pnpm --filter gateway run openapi:bundle',
    body,
  ].join('\n');
}

function escapeJsonPointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function fragmentReference(relativePath, pointer) {
  return `./cotsel-dashboard-gateway/${relativePath}#/${pointer}`;
}

export function renderDashboardGatewayIndex() {
  const { root, paths, pathSources, components, componentSources } =
    loadDashboardGatewaySpecParts();
  const indexedPaths = Object.fromEntries(
    Object.keys(paths).map((key) => [
      key,
      {
        $ref: fragmentReference(pathSources[key], `paths/${escapeJsonPointer(key)}`),
      },
    ]),
  );
  const indexedComponents = Object.fromEntries(
    Object.entries(components).map(([sectionName, section]) => [
      sectionName,
      Object.fromEntries(
        Object.keys(section).map((key) => [
          key,
          {
            $ref: fragmentReference(
              componentSources[sectionName][key],
              `components/${escapeJsonPointer(sectionName)}/${escapeJsonPointer(key)}`,
            ),
          },
        ]),
      ),
    ]),
  );
  const body = yaml.dump(
    { ...root, paths: indexedPaths, components: indexedComponents },
    {
      lineWidth: -1,
      noRefs: true,
      noCompatMode: true,
      sortKeys: false,
      flowLevel: 3,
    },
  );
  return [
    '# MODULAR OPENAPI INDEX. EDIT THE REFERENCED DOMAIN FRAGMENTS.',
    '# Manifest: ./cotsel-dashboard-gateway/manifest.json',
    '# Validate: pnpm openapi:dashboard:check',
    body,
  ].join('\n');
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function run() {
  const mode = process.argv[2] ?? '--check';
  if (mode === '--write-index') {
    const rendered = renderDashboardGatewayIndex();
    fs.writeFileSync(indexPath, rendered);
    process.stdout.write(
      `Wrote ${path.relative(repositoryRoot, indexPath)} sha256=${digest(rendered)}\n`,
    );
    return;
  }
  if (mode === '--write-bundle') {
    const rendered = renderDashboardGatewaySpec();
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, rendered);
    process.stdout.write(
      `Wrote ${path.relative(repositoryRoot, bundlePath)} sha256=${digest(rendered)}\n`,
    );
    return;
  }
  if (mode !== '--check') {
    throw new Error(`Unsupported mode ${mode}; use --check, --write-index, or --write-bundle`);
  }

  const expectedIndex = renderDashboardGatewayIndex();
  const existingIndex = fs.readFileSync(indexPath, 'utf8');
  if (existingIndex !== expectedIndex) {
    throw new Error(
      'Dashboard gateway OpenAPI index is stale; run pnpm --filter gateway run openapi:index',
    );
  }
  const assembled = assembleDashboardGatewaySpec();
  process.stdout.write(
    `Dashboard gateway OpenAPI source is current paths=${Object.keys(assembled.paths).length} ` +
      `schemas=${Object.keys(assembled.components.schemas ?? {}).length} ` +
      `indexSha256=${digest(existingIndex)}\n`,
  );
}

run();
