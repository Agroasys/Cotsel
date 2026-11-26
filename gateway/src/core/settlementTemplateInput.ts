/**
 * SPDX-License-Identifier: Apache-2.0
 */
// Request parsing for the settlement template routes (Cotsel#940). A template's
// hash covers every key, so the shape must be exact: an unknown key would
// become part of the reviewed terms. Value rules (shares summing to 10000 bps,
// one supplier-fee milestone, ...) stay in @agroasys/sdk settlementTemplateProblems.
import type { SettlementTemplate } from '@agroasys/sdk';
import { GatewayError } from '../errors';

type Shape = Record<string, 'string' | 'number' | 'boolean'>;

const ASSET: Shape = { symbol: 'string', decimals: 'number', quantumBaseUnits: 'string' };
const MILESTONE: Shape = { id: 'string', releaseBps: 'number', deductsSupplierFee: 'boolean' };
const FEES: Shape = {
  buyerBps: 'number',
  supplierBps: 'number',
  fixedSupportFeeBaseUnits: 'string',
  rounding: 'string',
};
const WINDOWS: Shape = {
  standardInspectionSeconds: 'number',
  packagedLocalInspectionSeconds: 'number',
  lockTimeoutSeconds: 'number',
  inTransitTimeoutSeconds: 'number',
  disputeProposalTtlSeconds: 'number',
};
const TOP_LEVEL = [
  'schemaVersion',
  'templateId',
  'version',
  'asset',
  'milestones',
  'fees',
  'windows',
] as const;

const MAX_MILESTONES = 16;
const TEMPLATE_ID = /^[a-z][a-z0-9.-]{1,62}$/u;

function invalid(message: string, field: string): GatewayError {
  return new GatewayError(400, 'VALIDATION_ERROR', message, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${field} must be an object`, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${field} must have exactly the keys ${expected.join(', ')}`, field);
  }
  return value;
}

function shaped(value: unknown, shape: Shape, field: string): Record<string, unknown> {
  const record = exactKeys(value, Object.keys(shape), field);
  for (const [key, type] of Object.entries(shape)) {
    const entry = record[key];
    const ok = type === 'number' ? Number.isFinite(entry) : typeof entry === type;
    if (!ok) throw invalid(`${field}.${key} must be a ${type}`, `${field}.${key}`);
  }
  return record;
}

/** Validates a request body's `template` structurally; value rules come from the SDK. */
export function parseSettlementTemplate(raw: unknown): SettlementTemplate {
  const template = exactKeys(raw, TOP_LEVEL, 'template');
  if (typeof template.schemaVersion !== 'string')
    throw invalid('template.schemaVersion must be a string', 'template.schemaVersion');
  if (typeof template.templateId !== 'string')
    throw invalid('template.templateId must be a string', 'template.templateId');
  if (!Number.isInteger(template.version))
    throw invalid('template.version must be an integer', 'template.version');
  shaped(template.asset, ASSET, 'template.asset');
  shaped(template.fees, FEES, 'template.fees');
  shaped(template.windows, WINDOWS, 'template.windows');
  const milestones = template.milestones;
  if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > MAX_MILESTONES) {
    throw invalid(
      `template.milestones must be an array of 1 to ${MAX_MILESTONES} milestones`,
      'template.milestones',
    );
  }
  milestones.forEach((milestone, index) =>
    shaped(milestone, MILESTONE, `template.milestones[${index}]`),
  );
  return template as unknown as SettlementTemplate;
}

export function parseTemplateId(raw: unknown): string {
  if (typeof raw !== 'string' || !TEMPLATE_ID.test(raw)) {
    throw invalid('Path parameter templateId is not a valid template id', 'templateId');
  }
  return raw;
}

export function parseTemplateVersion(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,8}$/u.test(raw)) {
    throw invalid('Path parameter version must be a positive integer', 'version');
  }
  return Number(raw);
}

/** Parses GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST: comma-separated `templateId:version`. */
export function parseTemplateActivationAllowlist(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [templateId, version, extra] = entry.split(':');
    if (
      extra !== undefined ||
      !TEMPLATE_ID.test(templateId ?? '') ||
      !/^[1-9][0-9]{0,8}$/u.test(version ?? '')
    ) {
      throw new Error(
        `GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST entry '${entry}' must be templateId:version`,
      );
    }
  }
  return [...new Set(entries)];
}
