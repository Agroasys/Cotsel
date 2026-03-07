/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { JsonRpcProvider } from 'ethers';
import { GatewayError } from '../src/errors';
import { GovernanceStatusService } from '../src/core/governanceStatusService';

describe('GovernanceStatusService', () => {
  test('maps on-chain governance state into the dashboard status shape', async () => {
    const provider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
    } as unknown as JsonRpcProvider;

    const service = new GovernanceStatusService(
      provider,
      {
        paused: jest.fn().mockResolvedValue(false),
        claimsPaused: jest.fn().mockResolvedValue(true),
        oracleActive: jest.fn().mockResolvedValue(true),
        oracleAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000011'),
        treasuryAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000022'),
        treasuryPayoutAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000033'),
        governanceApprovals: jest.fn().mockResolvedValue(2n),
        governanceTimelock: jest.fn().mockResolvedValue(86400n),
        requiredApprovals: jest.fn().mockResolvedValue(1n),
        hasActiveUnpauseProposal: jest.fn().mockResolvedValue(true),
        unpauseProposal: jest.fn().mockResolvedValue({
          approvalCount: 1n,
          executed: false,
          createdAt: 100n,
          proposer: '0x0000000000000000000000000000000000000099',
        }),
        oracleUpdateCounter: jest.fn().mockResolvedValue(3n),
        oracleUpdateProposals: jest.fn()
          .mockResolvedValueOnce({ createdAt: 10n, executed: false })
          .mockResolvedValueOnce({ createdAt: 11n, executed: true })
          .mockResolvedValueOnce({ createdAt: 12n, executed: false }),
        oracleUpdateProposalExpiresAt: jest.fn()
          .mockResolvedValueOnce(4102444800n)
          .mockResolvedValueOnce(4102444800n)
          .mockResolvedValueOnce(1n),
        oracleUpdateProposalCancelled: jest.fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false),
        treasuryPayoutAddressUpdateCounter: jest.fn().mockResolvedValue(2n),
        treasuryPayoutAddressUpdateProposals: jest.fn()
          .mockResolvedValueOnce({ createdAt: 20n, executed: false })
          .mockResolvedValueOnce({ createdAt: 21n, executed: false }),
        treasuryPayoutAddressUpdateProposalExpiresAt: jest.fn()
          .mockResolvedValueOnce(4102444800n)
          .mockResolvedValueOnce(4102444800n),
        treasuryPayoutAddressUpdateProposalCancelled: jest.fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
      } as any,
      31337,
    );

    const snapshot = await service.getGovernanceStatus();

    expect(snapshot).toEqual({
      paused: false,
      claimsPaused: true,
      oracleActive: true,
      oracleAddress: '0x0000000000000000000000000000000000000011',
      treasuryAddress: '0x0000000000000000000000000000000000000022',
      treasuryPayoutAddress: '0x0000000000000000000000000000000000000033',
      governanceApprovalsRequired: 2,
      governanceTimelockSeconds: 86400,
      requiredAdminCount: 1,
      hasActiveUnpauseProposal: true,
      activeUnpauseApprovals: 1,
      activeOracleProposalIds: [0],
      activeTreasuryPayoutReceiverProposalIds: [0],
    });
  });

  test('checkReadiness rejects chain id mismatch', async () => {
    const provider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31338n }),
    } as unknown as JsonRpcProvider;

    const service = new GovernanceStatusService(
      provider,
      {
        paused: jest.fn().mockResolvedValue(false),
      } as any,
      31337,
    );

    await expect(service.checkReadiness()).rejects.toEqual(expect.objectContaining<Partial<GatewayError>>({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    }));
  });
});
