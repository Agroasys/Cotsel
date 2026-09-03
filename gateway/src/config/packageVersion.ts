/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';

export function loadPackageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../package.json'),
    path.resolve(process.cwd(), 'gateway/package.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
    if (parsed.version) {
      return parsed.version;
    }
  }

  return '0.1.0';
}
