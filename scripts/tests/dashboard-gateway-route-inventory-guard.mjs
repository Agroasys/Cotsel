#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const inventoryPath = path.join(repoRoot, 'docs/runbooks/dashboard-gateway-route-inventory.md');
const workflowPath = path.join(repoRoot, '.github/workflows/dashboard-live-parity.yml');

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required file: ${path.relative(repoRoot, filePath)}`);
    return '';
  }

  return fs.readFileSync(filePath, 'utf8');
}

function routePathToLiteral(routePath) {
  return routePath.replace(/\{([^}]+)\}/g, ':$1');
}

const inventory = readRequired(inventoryPath);
const workflow = readRequired(workflowPath);

const routeRows = [
  ...inventory.matchAll(/\|\s*`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`\s*\|\s*`([^`]+)`\s*\|/g),
].map((match) => ({
  method: match[1].toLowerCase(),
  routePath: routePathToLiteral(match[2]),
  sourcePath: match[3],
}));

if (routeRows.length < 30) {
  fail(`Expected at least 30 inventory route rows, found ${routeRows.length}`);
}

for (const row of routeRows) {
  const absoluteSourcePath = path.join(repoRoot, row.sourcePath);
  const source = readRequired(absoluteSourcePath);

  if (!source.includes(row.routePath)) {
    fail(
      `${row.method.toUpperCase()} ${row.routePath} is documented against ${row.sourcePath}, but that route literal was not found in the source file`,
    );
  }
}

const requiredSections = [
  '## Source of Truth',
  '## Observed Dashboard Gateway Reads',
  '## Observed Dashboard Gateway Mutations',
  '## Auth Service Routes Used By Cotsel.dash',
  '## Keep Until Proven Dead',
  '## Cleanup Rule',
];

for (const section of requiredSections) {
  if (!inventory.includes(section)) {
    fail(`Missing route inventory section: ${section}`);
  }
}

if (!inventory.includes('POST /session/exchange/agroasys')) {
  fail('Route inventory must document the trusted Agroasys session exchange route.');
}

const authRoutes = readRequired(path.join(repoRoot, 'auth/src/api/routes.ts'));
if (!authRoutes.includes('/session/exchange/agroasys')) {
  fail('Auth routes no longer expose /session/exchange/agroasys.');
}

if (!workflow.includes('COTSEL_DASH_CHECKOUT_TOKEN')) {
  fail('Dashboard Live Parity workflow must require COTSEL_DASH_CHECKOUT_TOKEN.');
}

if (workflow.includes('secrets.COTSEL_DASH_CHECKOUT_TOKEN || github.token')) {
  fail('Dashboard Live Parity workflow must not fall back to github.token for Cotsel.dash.');
}

if (process.exitCode) {
  process.exit();
}

console.log('dashboard gateway route inventory guard: pass');
