#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT = 'reports/base-sepolia-pilot-validation/failure-evidence.json';

const SCENARIOS = {
  relayer_outage_or_disabled: {
    requiredChecks: ['readinessCaptured', 'broadcastPausedOrDisabled', 'noUserEthRequired'],
  },
  fallback_ux: {
    requiredChecks: ['fallbackPresented', 'operatorRecoveryPathCaptured', 'noUserEthRequired'],
  },
  operator_failure_rehearsal: {
    requiredChecks: ['readinessCaptured'],
    anyChecks: [
      'stuckQueueAlertVisible',
      'repeatedFailureAlertVisible',
      'droppedExecutionCaptured',
    ],
  },
};

function usage() {
  console.error(`Usage: node scripts/gasless-failure-evidence.mjs [options]

Options:
  --scenario <name>              One of: ${Object.keys(SCENARIOS).join(', ')}
  --output <path>                JSON output path. Default: ${DEFAULT_OUTPUT}
  --evidence-ref <ref>           Durable reference to the captured drill evidence
  --readiness-file <path>        Gateway relayer readiness JSON captured during the drill
  --fallback-file <path>         Optional fallback UX/operator recovery evidence JSON
  --no-user-eth-required         Assert the drill preserved the no-user-ETH model
  --fallback-presented           Assert the fallback UX was shown/captured
  --operator-recovery-captured   Assert operator recovery path was captured
  --dropped-execution-captured   Assert dropped execution evidence was captured
  --stdout                       Also print report JSON to stdout
`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    scenario: null,
    output: DEFAULT_OUTPUT,
    evidenceRef: null,
    readinessFile: null,
    fallbackFile: null,
    noUserEthRequired: false,
    fallbackPresented: false,
    operatorRecoveryCaptured: false,
    droppedExecutionCaptured: false,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--scenario':
        options.scenario = requireValue(argv, ++index, arg);
        break;
      case '--output':
        options.output = requireValue(argv, ++index, arg);
        break;
      case '--evidence-ref':
        options.evidenceRef = requireValue(argv, ++index, arg);
        break;
      case '--readiness-file':
        options.readinessFile = requireValue(argv, ++index, arg);
        break;
      case '--fallback-file':
        options.fallbackFile = requireValue(argv, ++index, arg);
        break;
      case '--no-user-eth-required':
        options.noUserEthRequired = true;
        break;
      case '--fallback-presented':
        options.fallbackPresented = true;
        break;
      case '--operator-recovery-captured':
        options.operatorRecoveryCaptured = true;
        break;
      case '--dropped-execution-captured':
        options.droppedExecutionCaptured = true;
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

  if (!options.scenario || !SCENARIOS[options.scenario]) {
    throw new Error(`--scenario must be one of: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  if (!options.evidenceRef || !options.evidenceRef.trim()) {
    throw new Error('--evidence-ref is required');
  }

  return options;
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    throw new Error(`Evidence input file does not exist: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function unwrapGatewayData(value) {
  return value?.data ?? value;
}

function hasAlert(readiness, code) {
  const snapshot = unwrapGatewayData(readiness);
  return (snapshot?.alerts ?? []).some((alert) => alert.code === code);
}

function readinessIsPausedOrDisabled(readiness) {
  const snapshot = unwrapGatewayData(readiness);
  return snapshot?.enabled === false || snapshot?.paused === true || snapshot?.state === 'paused';
}

export function buildFailureEvidence(options, now = new Date()) {
  const readiness = readJsonFile(options.readinessFile);
  const fallback = readJsonFile(options.fallbackFile);
  const checks = {
    readinessCaptured: Boolean(readiness),
    broadcastPausedOrDisabled: readiness ? readinessIsPausedOrDisabled(readiness) : false,
    noUserEthRequired: options.noUserEthRequired,
    fallbackPresented:
      options.fallbackPresented || Boolean(unwrapGatewayData(fallback)?.fallbackPresented),
    operatorRecoveryPathCaptured:
      options.operatorRecoveryCaptured ||
      Boolean(unwrapGatewayData(fallback)?.operatorRecoveryPathCaptured),
    stuckQueueAlertVisible: readiness ? hasAlert(readiness, 'gasless_queue_stuck') : false,
    repeatedFailureAlertVisible: readiness
      ? hasAlert(readiness, 'gasless_repeated_failures')
      : false,
    droppedExecutionCaptured: options.droppedExecutionCaptured,
  };

  const requirement = SCENARIOS[options.scenario];
  const blockers = [];
  for (const check of requirement.requiredChecks) {
    if (checks[check] !== true) {
      blockers.push(`missing required check: ${check}`);
    }
  }
  if (requirement.anyChecks && !requirement.anyChecks.some((check) => checks[check] === true)) {
    blockers.push(`one of these checks must be true: ${requirement.anyChecks.join(', ')}`);
  }

  return {
    scenario: options.scenario,
    status: blockers.length === 0 ? 'passed' : 'failed',
    observedAt: now.toISOString(),
    evidenceRef: options.evidenceRef.trim(),
    inputs: {
      readinessFile: options.readinessFile,
      fallbackFile: options.fallbackFile,
    },
    checks,
    blockers,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildFailureEvidence(options);
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const outputPath = path.isAbsolute(options.output)
    ? options.output
    : path.join(rootDir, options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  if (options.stdout) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`gasless failure evidence written: ${outputPath}`);
  }

  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
