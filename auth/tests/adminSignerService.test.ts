/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createAdminService } from '../src/core/adminService';
import type { OperatorSignerStore } from '../src/core/operatorSignerStore';
import type { ProfileStore } from '../src/core/profileStore';

const actor = {
  type: 'service_auth' as const,
  id: 'release-security-key',
  humanPrincipalId: 'agroasys-user:release-security',
};
const binding = {
  bindingId: '0199a0f0-0000-7000-8000-000000000001',
  accountId: 'acct-admin-1',
  walletAddress: '0x00000000000000000000000000000000000000aa',
  actionClass: 'governance' as const,
  environment: 'staging',
  custodianName: 'Admin Custodian One',
  approvingAuthority: null,
  approvedAt: null,
  approvalTicket: 'COTSEL-641',
  notes: null,
  state: 'pending' as const,
  evidenceDigest: 'a'.repeat(64),
  approvedByPrincipal: null,
  activatedAt: null,
  active: false,
  createdBy: actor.id,
  createdAt: '2026-09-11T10:01:00.000Z',
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
};

function createHarness(configured = true) {
  const signerStore: OperatorSignerStore = {
    list: jest.fn(async () => [binding]),
    propose: jest.fn(async () => binding),
    approve: jest.fn(async () => ({
      ...binding,
      state: 'active' as const,
      active: true,
      approvingAuthority: 'security-approver',
      approvedByPrincipal: 'security-approver',
      approvedAt: '2026-09-11T10:02:00.000Z',
      activatedAt: '2026-09-11T10:02:00.000Z',
    })),
    revoke: jest.fn(async () => binding),
  };
  const service = createAdminService(
    {} as ProfileStore,
    3600,
    configured ? signerStore : undefined,
  );
  return { service, signerStore };
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ' acct-admin-1 ',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    actionClass: 'governance' as const,
    environment: ' STAGING ',
    custodianName: ' Admin Custodian One ',
    approvalTicket: ' COTSEL-641 ',
    notes: ' witnessed on device ',
    actor,
    reason: ' Register witnessed hardware wallet authority. ',
    ...overrides,
  };
}

describe('AdminService operator signer register', () => {
  test('normalizes and forwards immutable signer proposal evidence', async () => {
    const { service, signerStore } = createHarness();

    await expect(service.proposeSigner(proposalInput())).resolves.toEqual(binding);
    expect(signerStore.propose).toHaveBeenCalledWith({
      accountId: 'acct-admin-1',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      actionClass: 'governance',
      environment: 'staging',
      custodianName: 'Admin Custodian One',
      approvalTicket: 'COTSEL-641',
      notes: 'witnessed on device',
      actor,
      reason: 'Register witnessed hardware wallet authority.',
    });
  });

  test.each([
    [{ environment: '*' }, 'wildcard'],
    [{ custodianName: 'x' }, 'custodianName'],
  ])('rejects incomplete or unsafe proposal evidence', async (overrides, message) => {
    const { service, signerStore } = createHarness();

    await expect(service.proposeSigner(proposalInput(overrides))).rejects.toThrow(message);
    expect(signerStore.propose).not.toHaveBeenCalled();
  });

  test('requires a canonical digest for approval', async () => {
    const { service, signerStore } = createHarness();
    await expect(
      service.approveSigner({
        bindingId: binding.bindingId,
        evidenceDigest: 'not-a-digest',
        actor: {
          type: 'service_auth',
          id: 'security-approver-key',
          humanPrincipalId: 'agroasys-user:security-approver',
        },
        reason: 'Approve independently witnessed custody.',
      }),
    ).rejects.toThrow('SHA-256');
    expect(signerStore.approve).not.toHaveBeenCalled();
  });

  test('fails closed when the signer register is not configured', async () => {
    const { service } = createHarness(false);

    await expect(service.listSignerBindings()).rejects.toThrow('not configured');
    await expect(service.proposeSigner(proposalInput())).rejects.toThrow('not configured');
    await expect(
      service.approveSigner({
        bindingId: binding.bindingId,
        evidenceDigest: 'a'.repeat(64),
        actor,
        reason: 'Approve independent custody evidence.',
      }),
    ).rejects.toThrow('not configured');
    await expect(
      service.revokeSigner({ bindingId: binding.bindingId, actor, reason: 'Revoke custody.' }),
    ).rejects.toThrow('not configured');
  });
});
