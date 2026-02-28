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
const shouldRunAdminMutationTests = shouldRunManualE2E && isAdminMutationE2ERequested;
const testAdminMutation = shouldRunAdminMutationTests ? test : test.skip;

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

type AdminMutationFixture = {
    TEST_TRADE_ID: bigint;
    TEST_DISPUTE_PROPOSAL_ID: bigint;
    TEST_ORACLE_PROPOSAL_ID: bigint;
    TEST_ADMIN_ADD_PROPOSAL_ID: bigint;
    TEST_NEW_ORACLE_ADDRESS: string;
    TEST_NEW_ADMIN_ADDRESS: string;
};

let adminMutationFixture: AdminMutationFixture | undefined;

function requireAdminMutationFixture(): AdminMutationFixture {
    if (!adminMutationFixture) {
        throw new Error('Admin mutation fixture not initialized. Ensure RUN_E2E=true and RUN_ADMIN_MUTATION_E2E=true.');
    }
    return adminMutationFixture;
}

describeIntegration('AdminSDK', () => {
    let adminSDK: AdminSDK;
    let adminSigner1: Signer;
    let adminSigner2: Signer;

    beforeAll(() => {
        assertRequiredEnv();
        adminSDK = new AdminSDK(TEST_CONFIG);
        adminSigner1 = getAdminSigner(1);
        adminSigner2 = getAdminSigner(2);

        if (shouldRunAdminMutationTests) {
            adminMutationFixture = {
                TEST_TRADE_ID: requireManualE2EBigIntEnv('TEST_TRADE_ID'),
                TEST_DISPUTE_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_DISPUTE_PROPOSAL_ID'),
                TEST_ORACLE_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_ORACLE_PROPOSAL_ID'),
                TEST_ADMIN_ADD_PROPOSAL_ID: requireManualE2EBigIntEnv('TEST_ADMIN_ADD_PROPOSAL_ID'),
                TEST_NEW_ORACLE_ADDRESS: requireManualE2EEnv('TEST_NEW_ORACLE_ADDRESS'),
                TEST_NEW_ADMIN_ADDRESS: requireManualE2EEnv('TEST_NEW_ADMIN_ADDRESS'),
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
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.proposeDisputeSolution(fixture.TEST_TRADE_ID, DisputeStatus.REFUND, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve dispute solution', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.approveDisputeSolution(fixture.TEST_DISPUTE_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired dispute proposal', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.cancelExpiredDisputeProposal(fixture.TEST_DISPUTE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose oracle update', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.proposeOracleUpdate(fixture.TEST_NEW_ORACLE_ADDRESS, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve oracle update', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.approveOracleUpdate(fixture.TEST_ORACLE_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should execute oracle update', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.executeOracleUpdate(fixture.TEST_ORACLE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired oracle update proposal', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.cancelExpiredOracleUpdateProposal(fixture.TEST_ORACLE_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should propose add admin', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.proposeAddAdmin(fixture.TEST_NEW_ADMIN_ADDRESS, adminSigner1);

        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should approve add admin', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.approveAddAdmin(fixture.TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner2);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should execute add admin', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.executeAddAdmin(fixture.TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should cancel expired add admin proposal', async () => {
        const fixture = requireAdminMutationFixture();
        const result = await adminSDK.cancelExpiredAddAdminProposal(fixture.TEST_ADMIN_ADD_PROPOSAL_ID, adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    testAdminMutation('should claim', async () => {
        const result = await adminSDK.claim(adminSigner1);
        
        expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
});
