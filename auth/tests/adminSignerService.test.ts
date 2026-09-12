/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createAdminService } from '../src/core/adminService';
import type { OperatorSignerStore } from '../src/core/operatorSignerStore';
import type { ProfileStore } from '../src/core/profileStore';

const actor = { type: 'service_auth' as const, id: 'release-security' };
const binding = {
  bindingId: '0199a0f0-0000-7000-8000-000000000001',
  accountId: 'acct-admin-1',
  walletAddress: '0x00000000000000000000000000000000000000aa',
  actionClass: 'governance' as const,
  environment: 'staging',
  custodianName: 'Admin Custodian One',
  approvingAuthority: 'Security Owner',
  approvedAt: '2026-09-11T10:00:00.000Z',
  approvalTicket: 'COTSEL-641',
  notes: null,
  active: true,
  createdBy: actor.id,
  createdAt: '2026-09-11T10:01:00.000Z',
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
};

function createHarness(configured = true) {
  const signerStore: OperatorSignerStore = {
    list: jest.fn(async () => [binding]),
    provision: jest.fn(async () => binding),
    revoke: jest.fn(async () => binding),
  };
  const service = createAdminService(
    {} as ProfileStore,
    3600,
    configured ? signerStore : undefined,
  );
  return { service, signerStore };
}

function provisionInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ' acct-admin-1 ',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    actionClass: 'governance' as const,
    environment: ' STAGING ',
    custodianName: ' Admin Custodian One ',
    approvingAuthority: ' Security Owner ',
    approvedAt: '2026-09-11T10:00:00.000Z',
    approvalTicket: ' COTSEL-641 ',
    notes: ' witnessed on device ',
    actor,
    reason: ' Register witnessed hardware wallet authority. ',
    ...overrides,
  };
}

describe('AdminService operator signer register', () => {
  test('normalizes and forwards complete custody approval evidence', async () => {
    const { service, signerStore } = createHarness();

    await expect(service.provisionSigner(provisionInput())).resolves.toEqual(binding);
    expect(signerStore.provision).toHaveBeenCalledWith({
      accountId: 'acct-admin-1',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      actionClass: 'governance',
      environment: 'staging',
      custodianName: 'Admin Custodian One',
      approvingAuthority: 'Security Owner',
      approvedAt: new Date('2026-09-11T10:00:00.000Z'),
      approvalTicket: 'COTSEL-641',
      notes: 'witnessed on device',
      actor,
      reason: 'Register witnessed hardware wallet authority.',
    });
  });

  test.each([
    [{ environment: '*' }, 'wildcard'],
    [{ approvedAt: 'not-a-date' }, 'ISO date-time'],
    [{ approvedAt: '2999-01-01T00:00:00.000Z' }, 'future'],
    [{ custodianName: 'x' }, 'custodianName'],
  ])('rejects incomplete or unsafe approval evidence', async (overrides, message) => {
    const { service, signerStore } = createHarness();

    await expect(service.provisionSigner(provisionInput(overrides))).rejects.toThrow(message);
    expect(signerStore.provision).not.toHaveBeenCalled();
  });

  test('fails closed when the signer register is not configured', async () => {
    const { service } = createHarness(false);

    await expect(service.listSignerBindings()).rejects.toThrow('not configured');
    await expect(service.provisionSigner(provisionInput())).rejects.toThrow('not configured');
    await expect(
      service.revokeSigner({ bindingId: binding.bindingId, actor, reason: 'Revoke custody.' }),
    ).rejects.toThrow('not configured');
  });
});
