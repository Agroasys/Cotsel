/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AGROASYS_LAUNCH_TEMPLATE_V1 } from '@agroasys/sdk';
import {
  parseSettlementTemplate,
  parseTemplateActivationAllowlist,
  parseTemplateId,
  parseTemplateVersion,
} from '../src/core/settlementTemplateInput';
import { loadConfigModule, withEnv } from './helpers/gatewayConfigTestHarness';

const RUNTIME = {
  GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
  GATEWAY_RPC_URL: undefined,
  GATEWAY_CHAIN_ID: undefined,
};
const v1 = () => structuredClone(AGROASYS_LAUNCH_TEMPLATE_V1);
const withoutFees = () =>
  Object.fromEntries(Object.entries(v1()).filter(([key]) => key !== 'fees'));

describe('settlement template request parsing (Cotsel#940)', () => {
  it('accepts exactly the template shape', () => {
    expect(parseSettlementTemplate(v1())).toEqual(AGROASYS_LAUNCH_TEMPLATE_V1);
  });

  it.each([
    ['a missing body', undefined, 'template'],
    ['an unknown top-level key', { ...v1(), notes: 'x' }, 'template'],
    ['a missing section', withoutFees(), 'template'],
    ['an unknown nested key', { ...v1(), asset: { ...v1().asset, issuer: 'x' } }, 'template.asset'],
    [
      'a wrongly typed value',
      { ...v1(), windows: { ...v1().windows, lockTimeoutSeconds: '1' } },
      'template.windows.lockTimeoutSeconds',
    ],
    ['a non-integer version', { ...v1(), version: 1.5 }, 'template.version'],
    ['no milestones', { ...v1(), milestones: [] }, 'template.milestones'],
    [
      'an unknown milestone key',
      { ...v1(), milestones: [{ ...v1().milestones[0], note: 'x' }] },
      'template.milestones[0]',
    ],
  ])('rejects %s with 400', (_label, body, field) => {
    expect(() => parseSettlementTemplate(body)).toThrow(
      expect.objectContaining({ statusCode: 400, details: { field } }),
    );
  });

  it('validates path parameters', () => {
    expect(parseTemplateId('agroasys.launch')).toBe('agroasys.launch');
    expect(parseTemplateVersion('12')).toBe(12);
    for (const bad of ['Agroasys', 'a', '../x', 7]) {
      expect(() => parseTemplateId(bad)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    for (const bad of ['0', '-1', '1.5', '01', 'x']) {
      expect(() => parseTemplateVersion(bad)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('parses the activation allowlist', () => {
    expect(
      parseTemplateActivationAllowlist(' agroasys.launch:1, agroasys.launch:1 ,x.y:2'),
    ).toEqual(['agroasys.launch:1', 'x.y:2']);
    for (const bad of ['agroasys.launch', 'agroasys.launch:0', 'a:b:c', 'Upper:1']) {
      expect(() => parseTemplateActivationAllowlist(bad)).toThrow(
        /GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST/,
      );
    }
  });

  it('defaults the gateway to activating only the contract-enforced v1', () => {
    withEnv(RUNTIME, () => {
      expect(loadConfigModule().loadConfig().settlementTemplateActivationAllowlist).toEqual([
        'agroasys.launch:1',
      ]);
    });
    withEnv({ ...RUNTIME, GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST: 'nope' }, () => {
      expect(() => loadConfigModule().loadConfig()).toThrow(
        /GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST/,
      );
    });
  });
});
