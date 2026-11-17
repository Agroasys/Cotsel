#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Validates the Cotsel controlled-pilot launch profile and, optionally, a resolved gateway
 * runtime environment against it. The command is read-only: it never contacts a chain, RPC or
 * provider. It prints one redacted JSON report and exits 1 when any check fails.
 *
 *   node scripts/validate-pilot-launch-profile.mjs
 *   node scripts/validate-pilot-launch-profile.mjs --env-file path/to/gateway.env --candidate-commit <sha>
 *   node scripts/validate-pilot-launch-profile.mjs --runtime-env --require-promotable
 *
 * The runtime check requires the candidate commit being promoted. --candidate-commit wins;
 * otherwise GITHUB_SHA is used, so a CI run binds to the workflow commit.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_PROFILE_PATH,
  ROOT_DIR,
  loadPilotLaunchInputs,
  validatePilotLaunchProfile,
} from './lib/pilot-launch-profile.mjs';
import { checkGatewayRuntimeAgainstProfile, parseEnvFile } from './lib/pilot-launch-runtime.mjs';

function parseArguments(argv) {
  const options = {
    profile: DEFAULT_PROFILE_PATH,
    envFile: undefined,
    candidateCommit: undefined,
    runtimeEnv: false,
    requirePromotable: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--profile' || name === '--env-file' || name === '--candidate-commit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      const key = { '--profile': 'profile', '--env-file': 'envFile' }[name] ?? 'candidateCommit';
      options[key] = value;
      index += 1;
    } else if (name === '--runtime-env') {
      options.runtimeEnv = true;
    } else if (name === '--require-promotable') {
      options.requirePromotable = true;
    } else {
      throw new Error(`unknown argument ${name}`);
    }
  }
  if (options.envFile && options.runtimeEnv) {
    throw new Error('use either --env-file or --runtime-env, not both');
  }
  return options;
}

export function run(argv = process.argv.slice(2), { env = process.env, rootDir = ROOT_DIR } = {}) {
  const options = parseArguments(argv);
  const inputs = loadPilotLaunchInputs(options.profile, rootDir);
  const profileBytes = readFileSync(path.resolve(rootDir, options.profile));
  const profileResult = validatePilotLaunchProfile(inputs.profile, {
    ...inputs,
    rootDir,
    requirePromotable: options.requirePromotable,
  });

  let runtime;
  if (options.envFile || options.runtimeEnv) {
    const runtimeEnv = options.envFile
      ? parseEnvFile(readFileSync(path.resolve(options.envFile), 'utf8'))
      : env;
    runtime = checkGatewayRuntimeAgainstProfile(inputs.profile, runtimeEnv, {
      candidateCommit: options.candidateCommit ?? env.GITHUB_SHA,
      requirePromotable: options.requirePromotable,
    });
  }

  const ok = profileResult.ok && (runtime?.ok ?? true);
  return {
    ok,
    report: {
      schemaVersion: 'cotsel.pilot-launch-profile-report.v1',
      profileId: inputs.profile?.profileId ?? null,
      profilePath: options.profile,
      profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
      profileStatus: inputs.profile?.status ?? null,
      requirePromotable: options.requirePromotable,
      candidateCommit: runtime ? (options.candidateCommit ?? env.GITHUB_SHA ?? null) : null,
      verdict: ok ? 'PASS' : 'FAIL',
      profile: profileResult,
      runtime: runtime ?? { checked: false },
    },
  };
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    const { ok, report } = run();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Pilot launch profile check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
