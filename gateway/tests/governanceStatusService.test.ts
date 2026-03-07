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
      getBlock: jest.fn().mockResolvedValue({ timestamp: 1000 }),
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
      50,
    );

    const snapshot = await service.getGovernanceStatus({
      oracleProposalIds: [0, 1, 2],
      treasuryPayoutReceiverProposalIds: [0, 1],
    });

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
      50,
    );

    await expect(service.checkReadiness()).rejects.toEqual(expect.objectContaining<Partial<GatewayError>>({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    }));
  });

  test('uses latest chain timestamp instead of host time when filtering active proposals', async () => {
    const provider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
      getBlock: jest.fn().mockResolvedValue({ timestamp: 500n }),
    } as unknown as JsonRpcProvider;

    const service = new GovernanceStatusService(
      provider,
      {
        paused: jest.fn().mockResolvedValue(false),
        claimsPaused: jest.fn().mockResolvedValue(false),
        oracleActive: jest.fn().mockResolvedValue(true),
        oracleAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000011'),
        treasuryAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000022'),
        treasuryPayoutAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000033'),
        governanceApprovals: jest.fn().mockResolvedValue(2n),
        governanceTimelock: jest.fn().mockResolvedValue(86400n),
        requiredApprovals: jest.fn().mockResolvedValue(1n),
        hasActiveUnpauseProposal: jest.fn().mockResolvedValue(false),
        unpauseProposal: jest.fn().mockResolvedValue({ approvalCount: 0n, executed: false, createdAt: 0n, proposer: '0x0' }),
        oracleUpdateProposals: jest.fn().mockResolvedValue({ createdAt: 10n, executed: false }),
        oracleUpdateProposalExpiresAt: jest.fn().mockResolvedValue(600n),
        oracleUpdateProposalCancelled: jest.fn().mockResolvedValue(false),
        treasuryPayoutAddressUpdateProposals: jest.fn().mockResolvedValue({ createdAt: 0n, executed: false }),
        treasuryPayoutAddressUpdateProposalExpiresAt: jest.fn().mockResolvedValue(0n),
        treasuryPayoutAddressUpdateProposalCancelled: jest.fn().mockResolvedValue(false),
      } as any,
      31337,
      50,
    );

    const snapshot = await service.getGovernanceStatus({
      oracleProposalIds: [7],
      treasuryPayoutReceiverProposalIds: [],
    });

    expect(snapshot.activeOracleProposalIds).toEqual([7]);
    expect(provider.getBlock).toHaveBeenCalledWith('latest');
  });

  test('fails readiness when chain RPC probe exceeds the configured timeout', async () => {
    const never = new Promise<never>(() => undefined);
    const provider = {
      getNetwork: jest.fn().mockReturnValue(never),
    } as unknown as JsonRpcProvider;

    const service = new GovernanceStatusService(
      provider,
      {
        paused: jest.fn().mockReturnValue(never),
      } as any,
      31337,
      10,
    );

    await expect(service.checkReadiness()).rejects.toEqual(expect.objectContaining<Partial<GatewayError>>({
      statusCode: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      details: expect.objectContaining({
        cause: 'timeout',
        upstream: 'chain-rpc',
        operation: 'checkReadiness',
      }),
    }));
  });
});
