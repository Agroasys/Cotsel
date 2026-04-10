/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import { AdminSDK } from '../src/modules/adminSDK';
import { DisputeStatus } from '../src/types/dispute';
import {
  TEST_CONFIG,
  assertRequiredEnv,
  getAdminSigner,
  getOptionalEnv,
  hasRequiredEnv,
} from './setup';
import { AgroasysEscrow__factory } from '../src/types/typechain-types/factories/src/AgroasysEscrow__factory';
import type { Signer } from 'ethers';
import { TX_HASH_REGEX } from './testUtils';

const isManualE2ERequested = process.env.RUN_E2E === 'true';
const shouldRunManualE2E = isManualE2ERequested && hasRequiredEnv;
const describeIntegration = shouldRunManualE2E ? describe : describe.skip;
const isAdminMutationE2ERequested = process.env.RUN_ADMIN_MUTATION_E2E === 'true';
const shouldRunAdminMutationTests = shouldRunManualE2E && isAdminMutationE2ERequested;
const testAdminMutation = shouldRunAdminMutationTests ? test : test.skip;

function requireManualE2EEnv(name: string): string {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required manual E2E environment variable: ${name}`);
  }
  return value;
}

function requireManualE2EBigIntEnv(name: string): bigint {
  const value = requireManualE2EEnv(name);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid bigint in manual E2E environment variable ${name}: ${value}`);
  }
}

type AdminMutationFixture = {
  TEST_TRADE_ID: bigint;
  TEST_DISPUTE_PROPOSAL_ID: bigint;
  TEST_ORACLE_PROPOSAL_ID: bigint;
  TEST_ADMIN_ADD_PROPOSAL_ID: bigint;
  TEST_TREASURY_PAYOUT_PROPOSAL_ID: bigint;
  TEST_NEW_ORACLE_ADDRESS: string;
  TEST_NEW_ADMIN_ADDRESS: string;
  TEST_NEW_TREASURY_PAYOUT_ADDRESS: string;
};

let adminMutationFixture: AdminMutationFixture | undefined;

function requireAdminMutationFixture(): AdminMutationFixture {
  if (!adminMutationFixture) {
    throw new Error(
      'Admin mutation fixture not initialized. Ensure RUN_E2E=true and RUN_ADMIN_MUTATION_E2E=true.',
    );
  }
  return adminMutationFixture;
}

describeIntegration('AdminSDK', () => {
  let adminSDK: AdminSDK;
  let adminSigner1: Signer;
  let adminSigner2: Signer;
  let escrowReadOnly: ReturnType<typeof AgroasysEscrow__factory.connect>;

  async function requireReceipt(
    provider: ethers.Provider | null | undefined,
    txHash: string,
  ): Promise<ethers.TransactionReceipt> {
    if (!provider) {
      throw new Error('adminSigner1 provider is unavailable');
    }
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`transaction receipt not found for hash: ${txHash}`);
    }
    return receipt;
  }

  async function findEventInReceipt(
    txHash: string,
    eventName: string,
  ): Promise<ethers.LogDescription | null> {
    const receipt = await requireReceipt(adminSigner1.provider, txHash);
    for (const log of receipt.logs) {
      try {
        const parsed = escrowReadOnly.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === eventName) {
          return parsed;
        }
      } catch {
        // Ignore non-contract logs.
      }
    }
    return null;
  }

  function expectValidTxHash(txHash: string): void {
    expect(txHash).toMatch(TX_HASH_REGEX);
  }

  beforeAll(() => {
    assertRequiredEnv();
    adminSDK = new AdminSDK(TEST_CONFIG);
    adminSigner1 = getAdminSigner(1);
    adminSigner2 = getAdminSigner(2);
    const provider = adminSigner1.provider;
    if (!provider) {
      throw new Error('adminSigner1 provider is unavailable');
    }
    escrowReadOnly = AgroasysEscrow__factory.connect(TEST_CONFIG.escrowAddress, provider);

    if (shouldRunAdminMutationTests) {
      adminMutationFixture = {
        TEST_TRADE_ID: requireManualE2EBigIntEnv('TEST_TRADE_ID'),
        TEST_DISPUTE_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_DISPUTE_PROPOSAL_ID'),
        TEST_ORACLE_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_ORACLE_PROPOSAL_ID'),
        TEST_ADMIN_ADD_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_ADMIN_ADD_PROPOSAL_ID'),
        TEST_TREASURY_PAYOUT_PROPOSAL_ID: requireManualE2EBigIntEnv(
          'TEST_TREASURY_PAYOUT_PROPOSAL_ID',
        ),
        TEST_NEW_ORACLE_ADDRESS: requireManualE2EEnv('TEST_NEW_ORACLE_ADDRESS'),
        TEST_NEW_ADMIN_ADDRESS: requireManualE2EEnv('TEST_NEW_ADMIN_ADDRESS'),
        TEST_NEW_TREASURY_PAYOUT_ADDRESS: requireManualE2EEnv('TEST_NEW_TREASURY_PAYOUT_ADDRESS'),
      };
    }
  });

  test('should verify admin status', async () => {
    const adminAddress1 = await adminSigner1.getAddress();
    const isAdmin1 = await adminSDK.isAdmin(adminAddress1);

    const adminAddress2 = await adminSigner2.getAddress();
    const isAdmin2 = await adminSDK.isAdmin(adminAddress2);

    expect(isAdmin1).toBe(true);
    expect(isAdmin2).toBe(true);
  });

  test('should return false for non-admin address', async () => {
    const nonAdminAddress = '0x0000000000000000000000000000000000000001';
    const isNonAdmin = await adminSDK.isAdmin(nonAdminAddress);
    expect(isNonAdmin).toBe(false);
  });

  testAdminMutation('should pause protocol', async () => {
    let wasPaused = await adminSDK.isPaused();
    if (wasPaused) {
      const unpauseProposal = await adminSDK.proposeUnpause(adminSigner1);
      expectValidTxHash(unpauseProposal.txHash);
      const unpauseApproval = await adminSDK.approveUnpause(adminSigner2);
      expectValidTxHash(unpauseApproval.txHash);
      wasPaused = await adminSDK.isPaused();
    }
    expect(wasPaused).toBe(false);
    const result = await adminSDK.pause(adminSigner1);

    expectValidTxHash(result.txHash);
    const isPaused = await adminSDK.isPaused();
    expect(isPaused).toBe(true);
  });

  testAdminMutation('should propose unpause', async () => {
    const result = await adminSDK.proposeUnpause(adminSigner1);

    expectValidTxHash(result.txHash);
    const unpauseProposed = await findEventInReceipt(result.txHash, 'UnpauseProposed');
    expect(unpauseProposed).not.toBeNull();
  });

  testAdminMutation('should approve unpause', async () => {
    const result = await adminSDK.approveUnpause(adminSigner2);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should cancel unpause proposal', async () => {
    const result = await adminSDK.cancelUnpauseProposal(adminSigner1);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should disable oracle emergency', async () => {
    const result = await adminSDK.disableOracleEmergency(adminSigner1);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should propose dispute solution', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.proposeDisputeSolution(
      fixture.TEST_TRADE_ID,
      DisputeStatus.REFUND,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
    const disputeProposed = await findEventInReceipt(result.txHash, 'DisputeSolutionProposed');
    expect(disputeProposed).not.toBeNull();
    expect(disputeProposed!.args.tradeId).toBe(fixture.TEST_TRADE_ID);
    expect(Number(disputeProposed!.args.disputeStatus)).toBe(DisputeStatus.REFUND);
  });

  testAdminMutation('should approve dispute solution', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.approveDisputeSolution(
      fixture.TEST_DISPUTE_PROPOSAL_ID,
      adminSigner2,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should cancel expired dispute proposal', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.cancelExpiredDisputeProposal(
      fixture.TEST_DISPUTE_PROPOSAL_ID,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should propose oracle update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.proposeOracleUpdate(
      fixture.TEST_NEW_ORACLE_ADDRESS,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
    const oracleProposed = await findEventInReceipt(result.txHash, 'OracleUpdateProposed');
    expect(oracleProposed).not.toBeNull();
    expect((oracleProposed!.args.newOracle as string).toLowerCase()).toBe(
      fixture.TEST_NEW_ORACLE_ADDRESS.toLowerCase(),
    );
  });

  testAdminMutation('should approve oracle update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.approveOracleUpdate(
      fixture.TEST_ORACLE_PROPOSAL_ID,
      adminSigner2,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should execute oracle update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.executeOracleUpdate(
      fixture.TEST_ORACLE_PROPOSAL_ID,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should cancel expired oracle update proposal', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.cancelExpiredOracleUpdateProposal(
      fixture.TEST_ORACLE_PROPOSAL_ID,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should propose add admin', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.proposeAddAdmin(fixture.TEST_NEW_ADMIN_ADDRESS, adminSigner1);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should approve add admin', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.approveAddAdmin(fixture.TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner2);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should execute add admin', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.executeAddAdmin(fixture.TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner1);

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should cancel expired add admin proposal', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.cancelExpiredAddAdminProposal(
      fixture.TEST_ADMIN_ADD_PROPOSAL_ID,
      adminSigner1,
    );

    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should pause claims', async () => {
    const initialClaimsPaused = await adminSDK.isClaimsPaused();
    if (initialClaimsPaused) {
      const unpauseResult = await adminSDK.unpauseClaims(adminSigner1);
      expectValidTxHash(unpauseResult.txHash);
      const isClaimsPausedAfterUnpause = await adminSDK.isClaimsPaused();
      expect(isClaimsPausedAfterUnpause).toBe(false);
    }
    const result = await adminSDK.pauseClaims(adminSigner1);
    expectValidTxHash(result.txHash);
    const isClaimsPaused = await adminSDK.isClaimsPaused();
    expect(isClaimsPaused).toBe(true);
  });

  testAdminMutation('should unpause claims', async () => {
    let isClaimsPausedInitially = await adminSDK.isClaimsPaused();
    if (!isClaimsPausedInitially) {
      const pauseResult = await adminSDK.pauseClaims(adminSigner1);
      expectValidTxHash(pauseResult.txHash);
      isClaimsPausedInitially = await adminSDK.isClaimsPaused();
    }
    expect(isClaimsPausedInitially).toBe(true);
    const result = await adminSDK.unpauseClaims(adminSigner1);
    expectValidTxHash(result.txHash);
    const isClaimsPaused = await adminSDK.isClaimsPaused();
    expect(isClaimsPaused).toBe(false);
  });

  testAdminMutation('should claim treasury', async () => {
    const result = await adminSDK.claimTreasury(adminSigner1);
    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should propose treasury payout address update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.proposeTreasuryPayoutAddressUpdate(
      fixture.TEST_NEW_TREASURY_PAYOUT_ADDRESS,
      adminSigner1,
    );
    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should approve treasury payout address update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.approveTreasuryPayoutAddressUpdate(
      fixture.TEST_TREASURY_PAYOUT_PROPOSAL_ID,
      adminSigner2,
    );
    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should execute treasury payout address update', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.executeTreasuryPayoutAddressUpdate(
      fixture.TEST_TREASURY_PAYOUT_PROPOSAL_ID,
      adminSigner1,
    );
    expectValidTxHash(result.txHash);
  });

  testAdminMutation('should cancel expired treasury payout address update proposal', async () => {
    const fixture = requireAdminMutationFixture();
    const result = await adminSDK.cancelExpiredTreasuryPayoutAddressUpdateProposal(
      fixture.TEST_TREASURY_PAYOUT_PROPOSAL_ID,
      adminSigner1,
    );
    expectValidTxHash(result.txHash);
  });
});
