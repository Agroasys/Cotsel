// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONFIG = 'config/source-line-limit.json';

export function countSourceLines(content) {
  if (content.length === 0) return 0;

  const normalized = content.replaceAll('\r\n', '\n');
  const lineCount = normalized.split('\n').length;
  return normalized.endsWith('\n') ? lineCount - 1 : lineCount;
}

export function isExcluded(file, config) {
  if (config.excludedPaths.includes(file)) return true;
  return config.excludedPrefixes.some((prefix) => file.startsWith(prefix));
}

export function existingTrackedFiles(root, trackedFiles) {
  return trackedFiles.filter((file) => existsSync(path.join(root, file)));
}

function validateConfig(config) {
  if (config.version !== 1) throw new Error('source-line-limit config version must be 1');
  if (!Number.isInteger(config.maxLines) || config.maxLines < 1) {
    throw new Error('source-line-limit maxLines must be a positive integer');
  }

  for (const key of ['extensions', 'excludedPaths', 'excludedPrefixes']) {
    if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string')) {
      throw new Error(`source-line-limit ${key} must be an array of strings`);
    }
  }

  if (!config.legacyBaseline || typeof config.legacyBaseline !== 'object') {
    throw new Error('source-line-limit legacyBaseline must be an object');
  }

  for (const [file, limit] of Object.entries(config.legacyBaseline)) {
    if (!Number.isInteger(limit) || limit <= config.maxLines) {
      throw new Error(`${file}: legacy baseline must be greater than maxLines`);
    }
    if (isExcluded(file, config)) {
      throw new Error(`${file}: excluded files must not be in legacyBaseline`);
    }
  }
}

export function evaluateTrackedSources({ root, config, trackedFiles }) {
  validateConfig(config);

  const extensions = new Set(config.extensions);
  const trackedSet = new Set(trackedFiles);
  const violations = [];
  const legacyFiles = [];

  for (const file of trackedFiles) {
    if (!extensions.has(path.extname(file)) || isExcluded(file, config)) continue;

    const lines = countSourceLines(readFileSync(path.join(root, file), 'utf8'));
    const legacyLimit = config.legacyBaseline[file];

    if (lines <= config.maxLines) {
      if (legacyLimit !== undefined) {
        violations.push(`${file}: now ${lines} lines; remove its stale legacy baseline`);
      }
      continue;
    }

    if (legacyLimit === undefined) {
      violations.push(`${file}: ${lines} lines exceeds the ${config.maxLines}-line limit`);
      continue;
    }

    if (lines > legacyLimit) {
      violations.push(`${file}: grew from the ${legacyLimit}-line baseline to ${lines} lines`);
      continue;
    }

    legacyFiles.push({ file, lines, legacyLimit });
  }

  for (const file of Object.keys(config.legacyBaseline)) {
    if (!trackedSet.has(file)) {
      violations.push(`${file}: no longer tracked; remove its stale legacy baseline`);
    }
  }

  return { violations: violations.sort(), legacyFiles };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), configPath: DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--config') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--root') options.root = path.resolve(value);
      else options.configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const configFile = path.resolve(options.root, options.configPath);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const trackedOutput = execFileSync('git', ['ls-files', '-z'], {
    cwd: options.root,
    encoding: 'utf8',
  });
  const trackedFiles = existingTrackedFiles(
    options.root,
    trackedOutput.split('\0').filter(Boolean),
  );
  const result = evaluateTrackedSources({ root: options.root, config, trackedFiles });

  if (result.violations.length > 0) {
    console.error(`Source line-limit check failed (${result.violations.length} violation(s)):`);
    for (const violation of result.violations) console.error(`- ${violation}`);
    return 1;
  }

  console.log(
    `Source line-limit check passed: max ${config.maxLines} lines; ` +
      `${result.legacyFiles.length} legacy oversized file(s) did not grow.`,
  );
  return 0;
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`Source line-limit check could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
