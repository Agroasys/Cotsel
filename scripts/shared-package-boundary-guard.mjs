#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const rootArgIndex = process.argv.indexOf('--root');
const repoRoot =
  rootArgIndex === -1 ? process.cwd() : path.resolve(process.argv[rootArgIndex + 1] ?? '.');

const forbiddenWorkspaceNames = [
  'auth',
  'contracts',
  'gateway',
  'indexer',
  'notifications',
  'oracle',
  'reconciliation',
  'ricardian',
  'sdk',
  'treasury',
];
const codeExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.d.ts']);

function discoverSharedPackageNames(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('shared-'))
    .map((entry) => entry.name)
    .sort();
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }

    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (codeExtensions.has(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function extractModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return specifiers;
}

function isForbiddenServiceImport(specifier) {
  const relativeSegments = specifier.startsWith('../')
    ? specifier.split('/').filter((segment) => segment.length > 0)
    : [];

  for (const workspaceName of forbiddenWorkspaceNames) {
    if (specifier === workspaceName || specifier.startsWith(`${workspaceName}/`)) {
      return true;
    }

    if (
      specifier === `@agroasys/${workspaceName}` ||
      specifier.startsWith(`@agroasys/${workspaceName}/`)
    ) {
      return true;
    }

    if (relativeSegments.includes(workspaceName)) {
      return true;
    }
  }

  return false;
}

function readPackageManifestDependencies(packageDir) {
  const packagePath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return [];
  }

  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

const violations = [];

for (const packageName of discoverSharedPackageNames(repoRoot)) {
  const packageDir = path.join(repoRoot, packageName);

  for (const dependencyName of readPackageManifestDependencies(packageDir)) {
    if (isForbiddenServiceImport(dependencyName)) {
      violations.push({
        file: path.relative(repoRoot, path.join(packageDir, 'package.json')),
        specifier: dependencyName,
      });
    }
  }

  for (const filePath of walkFiles(packageDir)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const specifier of extractModuleSpecifiers(source)) {
      if (isForbiddenServiceImport(specifier)) {
        violations.push({
          file: path.relative(repoRoot, filePath),
          specifier,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Shared package boundary guard failed: service imports found in shared packages.');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier}`);
  }
  process.exit(1);
}

console.log('Shared package boundary guard: pass');
