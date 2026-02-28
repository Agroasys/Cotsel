/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AdminSDK } from '../src/modules/adminSDK';
import { DisputeStatus } from '../src/types/dispute';
import { TEST_CONFIG, assertRequiredEnv, getAdminSigner, hasRequiredEnv } from './setup';
import type { Signer } from 'ethers';

const isManualE2ERequested = process.env.RUN_E2E === 'true';
const shouldRunManualE2E = isManualE2ERequested && hasRequiredEnv;
const describeIntegration = shouldRunManualE2E ? describe : describe.skip;
const isAdminMutationE2ERequested = process.env.RUN_ADMIN_MUTATION_E2E === 'true';
const testAdminMutation = shouldRunManualE2E && isAdminMutationE2ERequested ? test : test.skip;

function getOptionalEnv(name: string): string | undefined {
    const value = process.env[name];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

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

let TEST_TRADE_ID: bigint = 0n;
let TEST_DISPUTE_PROPOSAL_ID: bigint = 0n;
let TEST_ORACLE_PROPOSAL_ID: bigint = 0n;
let TEST_ADMIN_ADD_PROPOSAL_ID: bigint = 0n;
let TEST_NEW_ORACLE_ADDRESS = '0x0000000000000000000000000000000000000000';
let TEST_NEW_ADMIN_ADDRESS = '0x0000000000000000000000000000000000000000';

describeIntegration('AdminSDK', () => {
    let adminSDK: AdminSDK;
    let adminSigner1: Signer;
    let adminSigner2: Signer;

    beforeAll(() => {
        assertRequiredEnv();
        adminSDK = new AdminSDK(TEST_CONFIG);
        adminSigner1 = getAdminSigner(1);
        adminSigner2 = getAdminSigner(2);

        if (shouldRunManualE2E && isAdminMutationE2ERequested) {
            TEST_TRADE_ID = requireManualE2EBigIntEnv('TEST_TRADE_ID');
            TEST_DISPUTE_PROPOSAL_ID = requireManualE2EBigIntEnv('TEST_DISPUTE_PROPOSAL_ID');
            TEST_ORACLE_PROPOSAL_ID = requireManualE2EBigIntEnv('TEST_ORACLE_PROPOSAL_ID');
            TEST_ADMIN_ADD_PROPOSAL_ID = requireManualE2EBigIntEnv('TEST_ADMIN_ADD_PROPOSAL_ID');
            TEST_NEW_ORACLE_ADDRESS = requireManualE2EEnv('NEW_ORACLE_ADDRESS');
            TEST_NEW_ADMIN_ADDRESS = requireManualE2EEnv('NEW_ADMIN_ADDRESS');
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

    testAdminMutation('should pause protocol', async () => {
        const result = await adminSDK.pause(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose unpause', async () => {
        const result = await adminSDK.proposeUnpause(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve unpause', async () => {
        const result = await adminSDK.approveUnpause(adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel unpause proposal', async () => {
        const result = await adminSDK.cancelUnpauseProposal(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should disable oracle emergency', async () => {
        const result = await adminSDK.disableOracleEmergency(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose dispute solution', async () => {
        const result = await adminSDK.proposeDisputeSolution(TEST_TRADE_ID, DisputeStatus.REFUND, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve dispute solution', async () => {
        const result = await adminSDK.approveDisputeSolution(TEST_DISPUTE_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired dispute proposal', async () => {
        const result = await adminSDK.cancelExpiredDisputeProposal(TEST_DISPUTE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose oracle update', async () => {
        const result = await adminSDK.proposeOracleUpdate(TEST_NEW_ORACLE_ADDRESS, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve oracle update', async () => {
        const result = await adminSDK.approveOracleUpdate(TEST_ORACLE_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should execute oracle update', async () => {
        const result = await adminSDK.executeOracleUpdate(TEST_ORACLE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired oracle update proposal', async () => {
        const result = await adminSDK.cancelExpiredOracleUpdateProposal(TEST_ORACLE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose add admin', async () => {
        const result = await adminSDK.proposeAddAdmin(TEST_NEW_ADMIN_ADDRESS, adminSigner1);

        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve add admin', async () => {
        const result = await adminSDK.approveAddAdmin(TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should execute add admin', async () => {
        const result = await adminSDK.executeAddAdmin(TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired add admin proposal', async () => {
        const result = await adminSDK.cancelExpiredAddAdminProposal(TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should claim', async () => {
        const result = await adminSDK.claim(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
});
