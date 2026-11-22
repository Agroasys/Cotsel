/**
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type AnyExecutionAdapter,
  type ExecutionCapability,
  executionDescriptorProblems,
  isExecutionCapability,
} from './adapters';
import { custodyModePermits, type CustodyMode, isCustodyMode } from './custody';
import { canonicalExecutionHash } from './verification';

/**
 * Deployment configuration, for example parsed from a JSON environment value:
 * `{ "custodyMode": "non_custodial", "adapters": { "signing": "aws-kms-signer" } }`.
 */
export interface ExecutionConfigInput {
  custodyMode: CustodyMode;
  adapters: Partial<Record<ExecutionCapability, string>>;
}

export type ExecutionConfigProblemCode =
  | 'config_not_object'
  | 'config_unknown_key'
  | 'custody_mode_missing'
  | 'custody_mode_unknown'
  | 'adapters_not_object'
  | 'capability_unknown'
  | 'capability_required'
  | 'adapter_id_invalid'
  | 'adapter_not_registered'
  | 'adapter_capability_mismatch'
  | 'adapter_custody_forbidden'
  | 'registry_descriptor_invalid'
  | 'registry_duplicate_id'
  | 'timeout_invalid';

export interface ExecutionConfigProblem {
  code: ExecutionConfigProblemCode;
  /** Capability, adapter id or key the problem is about. Never a secret. */
  subject?: string;
}

export interface ExecutionRouteDeclaration {
  adapterId: string;
  adapterVersion: string;
  custodyClass: CustodyMode;
}

/**
 * The custody declaration a deployment runs under. Record `configHash` with every
 * settlement and operation so evidence shows which routing applied.
 */
export interface ExecutionCustodyDeclaration {
  custodyMode: CustodyMode;
  routes: Partial<Record<ExecutionCapability, ExecutionRouteDeclaration>>;
  configHash: string;
}

export type ExecutionConfigValidation =
  | { ok: true; declaration: ExecutionCustodyDeclaration }
  | { ok: false; problems: ExecutionConfigProblem[] };

export interface ValidateExecutionConfigOptions {
  /** Capabilities this service needs. A missing route is a readiness failure. */
  requiredCapabilities?: readonly ExecutionCapability[];
}

const CONFIG_KEYS = new Set(['custodyMode', 'adapters']);

export function registryProblems(
  adapters: readonly AnyExecutionAdapter[],
): ExecutionConfigProblem[] {
  const problems: ExecutionConfigProblem[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    const descriptorProblems = executionDescriptorProblems(adapter?.descriptor);
    const id = typeof adapter?.descriptor?.id === 'string' ? adapter.descriptor.id : undefined;
    if (descriptorProblems.length > 0) {
      problems.push({ code: 'registry_descriptor_invalid', subject: id });
      continue;
    }
    if (seen.has(adapter.descriptor.id)) {
      problems.push({ code: 'registry_duplicate_id', subject: adapter.descriptor.id });
    }
    seen.add(adapter.descriptor.id);
  }
  return problems;
}

/**
 * Validates deployment configuration against the registered adapters. Unknown or
 * conflicting configuration is reported, never repaired: the caller must fail
 * readiness on any problem.
 */
export function validateExecutionConfig(
  raw: unknown,
  adapters: readonly AnyExecutionAdapter[],
  options: ValidateExecutionConfigOptions = {},
): ExecutionConfigValidation {
  const problems = registryProblems(adapters);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: [...problems, { code: 'config_not_object' }] };
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) {
      problems.push({ code: 'config_unknown_key', subject: key });
    }
  }

  const custodyMode = input.custodyMode;
  if (custodyMode === undefined || custodyMode === null || custodyMode === '') {
    problems.push({ code: 'custody_mode_missing' });
  } else if (!isCustodyMode(custodyMode)) {
    problems.push({ code: 'custody_mode_unknown', subject: String(custodyMode) });
  }

  const routesInput = input.adapters;
  const routes: Partial<Record<ExecutionCapability, ExecutionRouteDeclaration>> = {};
  if (typeof routesInput !== 'object' || routesInput === null || Array.isArray(routesInput)) {
    problems.push({ code: 'adapters_not_object' });
  } else {
    const byId = new Map(adapters.map((adapter) => [adapter.descriptor?.id, adapter]));
    for (const [capability, adapterId] of Object.entries(routesInput)) {
      if (!isExecutionCapability(capability)) {
        problems.push({ code: 'capability_unknown', subject: capability });
        continue;
      }
      if (typeof adapterId !== 'string' || adapterId.length === 0) {
        problems.push({ code: 'adapter_id_invalid', subject: capability });
        continue;
      }
      const adapter = byId.get(adapterId);
      if (!adapter) {
        problems.push({ code: 'adapter_not_registered', subject: adapterId });
        continue;
      }
      if (adapter.descriptor.capability !== capability) {
        problems.push({ code: 'adapter_capability_mismatch', subject: adapterId });
        continue;
      }
      if (
        isCustodyMode(custodyMode) &&
        !custodyModePermits(custodyMode, adapter.descriptor.custodyClass)
      ) {
        problems.push({ code: 'adapter_custody_forbidden', subject: adapterId });
        continue;
      }
      routes[capability] = {
        adapterId,
        adapterVersion: adapter.descriptor.version,
        custodyClass: adapter.descriptor.custodyClass,
      };
    }
  }

  for (const capability of options.requiredCapabilities ?? []) {
    const configured =
      typeof routesInput === 'object' && routesInput !== null && capability in routesInput;
    if (!configured) {
      problems.push({ code: 'capability_required', subject: capability });
    }
  }

  if (problems.length > 0 || !isCustodyMode(custodyMode)) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    declaration: {
      custodyMode,
      routes,
      configHash: canonicalExecutionHash({
        schema: 'cotsel.execution-custody-declaration.v1',
        custodyMode,
        routes,
      }),
    },
  };
}
