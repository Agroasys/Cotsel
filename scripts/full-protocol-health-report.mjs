#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachCommandResults,
  buildStaticProtocolReport,
  DEFAULT_PROFILE,
  DEFAULT_REPORT_PATH,
} from './lib/full-protocol-health-report.mjs';

function usage() {
  console.error(`Usage: node scripts/full-protocol-health-report.mjs [options]

Options:
  --profile <name>          Runtime profile. Default: ${DEFAULT_PROFILE}
  --mode <config-only|live> Report mode. Default: config-only
  --output <path>           JSON output path. Default: ${DEFAULT_REPORT_PATH}
  --session-file <path>     Trusted dashboard session artifact to inspect
  --run-validate-env        Execute scripts/validate-env.sh for the profile
  --run-docker-health       Execute scripts/cotsel.sh health
  --run-staging-gate        Execute scripts/runtime-gate.sh
  --timeout-ms <number>     Timeout per command. Default: 300000
  --stdout                  Also print the JSON report to stdout
`);
}

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    mode: 'config-only',
    output: DEFAULT_REPORT_PATH,
    sessionFile: null,
    runValidateEnv: false,
    runDockerHealth: false,
    runStagingGate: false,
    timeoutMs: 300000,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--profile':
        options.profile = requireValue(argv, ++index, arg);
        break;
      case '--mode':
        options.mode = requireValue(argv, ++index, arg);
        if (!['config-only', 'live'].includes(options.mode)) {
          throw new Error('--mode must be config-only or live');
        }
        break;
      case '--output':
        options.output = requireValue(argv, ++index, arg);
        break;
      case '--session-file':
        options.sessionFile = requireValue(argv, ++index, arg);
        break;
      case '--run-validate-env':
        options.runValidateEnv = true;
        break;
      case '--run-docker-health':
        options.runDockerHealth = true;
        break;
      case '--run-staging-gate':
        options.runStagingGate = true;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(requireValue(argv, ++index, arg));
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error('--timeout-ms must be a positive integer');
        }
        break;
      case '--stdout':
        options.stdout = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(process.argv.slice(2));
  const report = attachCommandResults(
    buildStaticProtocolReport({
      rootDir,
      profile: options.profile,
      mode: options.mode,
      sessionFile: options.sessionFile,
    }),
    {
      rootDir,
      runValidateEnv: options.runValidateEnv,
      runDockerHealth: options.runDockerHealth,
      runStagingGate: options.runStagingGate,
      timeoutMs: options.timeoutMs,
    },
  );

  const outputPath = path.isAbsolute(options.output)
    ? options.output
    : path.join(rootDir, options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  if (options.stdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`full protocol health report: ${report.status}`);
    console.log(`report: ${path.relative(rootDir, outputPath)}`);
  }

  process.exit(report.status === 'pass' ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
