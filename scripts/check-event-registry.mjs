#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fails when a published event schema changed in place, a new version breaks
// the previous one, or the emitted notification types drift from the registry.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryProblems } from './lib/event-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = registryProblems(root);
if (problems.length > 0) {
  console.error('Event schema registry check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('Event schema registry check passed.');
