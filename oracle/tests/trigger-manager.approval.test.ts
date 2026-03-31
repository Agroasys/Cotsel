import { TriggerManager } from '../src/core/trigger-manager';
import { TriggerStatus, TriggerType, Trigger, ErrorType } from '../src/types/trigger';
import { ValidationError } from '../src/utils/errors';

jest.mock('@agroasys/sdk', () => ({
    TradeStatus: { LOCKED: 0, IN_TRANSIT: 1, ARRIVAL_CONFIRMED: 2, FROZEN: 3, CLOSED: 4 },
}));

jest.mock('../src/database/queries', () => ({
    createTrigger: jest.fn(),
    getTriggerByIdempotencyKey: jest.fn(),
    getLatestTriggerByActionKey: jest.fn(),
    updateTrigger: jest.fn(),
    approveTrigger: jest.fn(),
    rejectTrigger: jest.fn(),
}));

jest.mock('../src/metrics/counters', () => ({
    incrementOracleExhaustedRetries: jest.fn(),
    incrementOracleRedriveAttempts: jest.fn(),
    incrementOraclePendingApproval: jest.fn(),
    incrementOracleApproved: jest.fn(),
    incrementOracleRejected: jest.fn(),
}));

jest.mock('../src/utils/crypto', () => ({
    ...jest.requireActual('../src/utils/crypto'),
    calculateBackoff: jest.fn(() => 0),
}));

import {
    approveTrigger as mockApproveTrigger,
    rejectTrigger as mockRejectTrigger,
    getTriggerByIdempotencyKey as mockGetTriggerByIdempotencyKey,
    updateTrigger as mockUpdateTrigger,
    getLatestTriggerByActionKey as mockGetLatestTriggerByActionKey,
    createTrigger as mockCreateTrigger,
} from '../src/database/queries';
import {
    incrementOraclePendingApproval,
    incrementOracleApproved,
    incrementOracleRejected,
} from '../src/metrics/counters';

function buildTrigger(overrides: Partial<Trigger> = {}): Trigger {
    return {
        id: 1,
        action_key: 'RELEASE_STAGE_1:1',
        request_id: 'req-1',
        idempotency_key: 'RELEASE_STAGE_1:1:req-1',
        trade_id: '1',
        trigger_type: TriggerType.RELEASE_STAGE_1,
        request_hash: null,
        attempt_count: 0,
        status: TriggerStatus.PENDING_APPROVAL,
        tx_hash: null,
        block_number: null,
        confirmation_stage: null,
        confirmation_stage_at: null,
        indexer_confirmed: false,
        indexer_confirmed_at: null,
        indexer_event_id: null,
        last_error: null,
        error_type: null as ErrorType | null,
        on_chain_verified: false,
        on_chain_verified_at: null,
        approved_by: null,
        approved_at: null,
        rejected_by: null,
        rejected_at: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        submitted_at: null,
        confirmed_at: null,
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    };
}

function buildManager(): TriggerManager {
    const sdkClient = {
        getTrade: jest.fn(),
        releaseFundsStage1: jest.fn(),
        confirmArrival: jest.fn(),
        finalizeTrade: jest.fn(),
    } as any;
    return new TriggerManager(sdkClient, 3, 0, undefined, true);
}

describe('TriggerManager — manual approval gate', () => {
    beforeEach(() => jest.clearAllMocks());


    it('sets PENDING_APPROVAL and returns early when manualApprovalEnabled=true', async () => {
        const sdkClient = {
            getTrade: jest.fn().mockResolvedValue({
                tradeId: '1',
                status: 0,
                buyer: '0xabc',
                supplier: '0xdef',
                totalAmountLocked: 0n,
                logisticsAmount: 0n,
                platformFeesAmount: 0n,
                supplierFirstTranche: 0n,
                supplierSecondTranche: 0n,
                ricardianHash: '0x' + '00'.repeat(32),
                createdAt: new Date(),
            }),
            releaseFundsStage1: jest.fn(),
        } as any;

        const trigger = buildTrigger({ status: TriggerStatus.PENDING });
        (mockGetLatestTriggerByActionKey as jest.Mock).mockResolvedValue(null);
        (mockGetTriggerByIdempotencyKey as jest.Mock).mockResolvedValue(null);
        (mockCreateTrigger as jest.Mock).mockResolvedValue(trigger);
        (mockUpdateTrigger as jest.Mock).mockResolvedValue(undefined);

        const manager = new TriggerManager(sdkClient, 3, 0, undefined, true);
        const result = await manager.executeTrigger({
            tradeId: '1',
            requestId: 'req-1',
            triggerType: TriggerType.RELEASE_STAGE_1,
        });

        expect(result.status).toBe(TriggerStatus.PENDING_APPROVAL);
        expect(mockUpdateTrigger).toHaveBeenCalledWith(
            trigger.idempotency_key,
            { status: TriggerStatus.PENDING_APPROVAL }
        );
        expect(sdkClient.releaseFundsStage1).not.toHaveBeenCalled();
        expect(incrementOraclePendingApproval).toHaveBeenCalledWith(trigger.action_key);
    });

    it('does NOT gate redrives even when manualApprovalEnabled=true', async () => {
        const exhausted = buildTrigger({ status: TriggerStatus.EXHAUSTED_NEEDS_REDRIVE });
        (mockGetLatestTriggerByActionKey as jest.Mock).mockResolvedValue(exhausted);

        const sdkClient = {
            getTrade: jest.fn().mockResolvedValue({
                tradeId: '1', status: 0, buyer: '0xabc', supplier: '0xdef',
                totalAmountLocked: 0n, logisticsAmount: 0n, platformFeesAmount: 0n,
                supplierFirstTranche: 0n, supplierSecondTranche: 0n,
                ricardianHash: '0x' + '00'.repeat(32), createdAt: new Date(),
            }),
            releaseFundsStage1: jest.fn().mockResolvedValue({ txHash: '0xabcd', blockNumber: 1 }),
        } as any;

        const newTrigger = buildTrigger({ status: TriggerStatus.PENDING });
        (mockCreateTrigger as jest.Mock).mockResolvedValue(newTrigger);
        (mockUpdateTrigger as jest.Mock).mockResolvedValue(undefined);

        const manager = new TriggerManager(sdkClient, 3, 0, undefined, true);
        const result = await manager.executeTrigger({
            tradeId: '1',
            requestId: 'req-redrive',
            triggerType: TriggerType.RELEASE_STAGE_1,
            isRedrive: true,
        });

        expect(result.status).toBe(TriggerStatus.SUBMITTED);
        expect(sdkClient.releaseFundsStage1).toHaveBeenCalledTimes(1);
    });


    it('resumeAfterApproval: approves trigger, increments counter, and calls executeWithRetry', async () => {
        const approved = buildTrigger({
            status: TriggerStatus.PENDING,
            approved_by: 'operator@agroasys',
            approved_at: new Date(),
        });

        (mockApproveTrigger as jest.Mock).mockResolvedValue(approved);
        (mockUpdateTrigger as jest.Mock).mockResolvedValue(undefined);

        const sdkClient = {
            getTrade: jest.fn().mockResolvedValue({
                tradeId: '1', status: 0, buyer: '0xabc', supplier: '0xdef',
                totalAmountLocked: 0n, logisticsAmount: 0n, platformFeesAmount: 0n,
                supplierFirstTranche: 0n, supplierSecondTranche: 0n,
                ricardianHash: '0x' + '00'.repeat(32), createdAt: new Date(),
            }),
            releaseFundsStage1: jest.fn().mockResolvedValue({ txHash: '0xdeadbeef', blockNumber: 42 }),
        } as any;

        const manager = new TriggerManager(sdkClient, 3, 0, undefined, true);
        const result = await manager.resumeAfterApproval(approved.idempotency_key, 'operator@agroasys');

        expect(mockApproveTrigger).toHaveBeenCalledWith(approved.idempotency_key, 'operator@agroasys');
        expect(incrementOracleApproved).toHaveBeenCalledWith(approved.action_key);
        expect(result.status).toBe(TriggerStatus.SUBMITTED);
        expect(result.txHash).toBe('0xdeadbeef');
    });

    it('resumeAfterApproval: returns current state idempotently when already processed', async () => {
        const alreadySubmitted = buildTrigger({ status: TriggerStatus.SUBMITTED, tx_hash: '0xexisting' });

        (mockApproveTrigger as jest.Mock).mockResolvedValue(null); // not in PENDING_APPROVAL
        (mockGetTriggerByIdempotencyKey as jest.Mock).mockResolvedValue(alreadySubmitted);

        const manager = buildManager();
        const result = await manager.resumeAfterApproval(alreadySubmitted.idempotency_key, 'operator@agroasys');

        expect(result.status).toBe(TriggerStatus.SUBMITTED);
        expect(result.message).toBe('Trigger already processed');
        expect(incrementOracleApproved).not.toHaveBeenCalled();
    });

    it('resumeAfterApproval: throws ValidationError when trigger does not exist', async () => {
        (mockApproveTrigger as jest.Mock).mockResolvedValue(null);
        (mockGetTriggerByIdempotencyKey as jest.Mock).mockResolvedValue(null);

        const manager = buildManager();
        await expect(
            manager.resumeAfterApproval('non-existent-key', 'operator@agroasys')
        ).rejects.toBeInstanceOf(ValidationError);
    });


    it('rejectPendingTrigger: rejects trigger, increments counter, returns REJECTED', async () => {
        const rejected = buildTrigger({
            status: TriggerStatus.REJECTED,
            rejected_by: 'oncall@agroasys',
            rejected_at: new Date(),
        });

        (mockRejectTrigger as jest.Mock).mockResolvedValue(rejected);

        const manager = buildManager();
        const result = await manager.rejectPendingTrigger(
            rejected.idempotency_key,
            'oncall@agroasys',
            'duplicate risk'
        );

        expect(mockRejectTrigger).toHaveBeenCalledWith(
            rejected.idempotency_key,
            'oncall@agroasys',
            'duplicate risk'
        );
        expect(incrementOracleRejected).toHaveBeenCalledWith(rejected.action_key);
        expect(result.status).toBe(TriggerStatus.REJECTED);
        expect(result.message).toContain('oncall@agroasys');
    });

    it('rejectPendingTrigger: returns current state idempotently when already rejected', async () => {
        const alreadyRejected = buildTrigger({ status: TriggerStatus.REJECTED });

        (mockRejectTrigger as jest.Mock).mockResolvedValue(null);
        (mockGetTriggerByIdempotencyKey as jest.Mock).mockResolvedValue(alreadyRejected);

        const manager = buildManager();
        const result = await manager.rejectPendingTrigger(
            alreadyRejected.idempotency_key,
            'oncall@agroasys'
        );

        expect(result.status).toBe(TriggerStatus.REJECTED);
        expect(result.message).toBe('Trigger already processed');
        expect(incrementOracleRejected).not.toHaveBeenCalled();
    });

    it('rejectPendingTrigger: throws ValidationError when trigger does not exist', async () => {
        (mockRejectTrigger as jest.Mock).mockResolvedValue(null);
        (mockGetTriggerByIdempotencyKey as jest.Mock).mockResolvedValue(null);

        const manager = buildManager();
        await expect(
            manager.rejectPendingTrigger('non-existent-key', 'oncall@agroasys')
        ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejectPendingTrigger: works without optional reason param', async () => {
        const rejected = buildTrigger({ status: TriggerStatus.REJECTED });
        (mockRejectTrigger as jest.Mock).mockResolvedValue(rejected);

        const manager = buildManager();
        const result = await manager.rejectPendingTrigger(
            rejected.idempotency_key,
            'operator@agroasys'
        );

        expect(mockRejectTrigger).toHaveBeenCalledWith(
            rejected.idempotency_key,
            'operator@agroasys',
            undefined
        );
        expect(result.status).toBe(TriggerStatus.REJECTED);
    });
});
