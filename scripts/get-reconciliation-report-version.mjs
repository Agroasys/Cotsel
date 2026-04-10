#!/usr/bin/env node

import fs from 'node:fs';

const filePath = process.argv[2];

if (!filePath) {
  process.exit(0);
}

try {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = source.match(/RECONCILIATION_REPORT_VERSION\s*=\s*["']([^"']+)["']/);
  if (match?.[1]) {
    process.stdout.write(match[1]);
  }
} catch {
  // Silent fallback is intentional; caller handles default.
}
