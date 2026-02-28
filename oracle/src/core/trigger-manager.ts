import { SDKClient, BlockchainResult } from '../blockchain/sdk-client';
import { StateValidator } from './state-validator';
import { Trigger, TriggerType, TriggerStatus, CreateTriggerData } from '../types/trigger';
import {createTrigger,getTriggerByIdempotencyKey,getLatestTriggerByActionKey,updateTrigger,} from '../database/queries';
import {generateActionKey,generateRequestId,generateIdempotencyKey,calculateBackoff,} from '../utils/crypto';
import {classifyError,determineNextStatus,ValidationError,} from '../utils/errors';
import { Logger } from '../utils/logger';
import { incrementOracleExhaustedRetries, incrementOracleRedriveAttempts,incrementOraclePendingApproval,incrementOracleApproved,incrementOracleRejected} from '../metrics/counters';
import { WebhookNotifier } from '@agroasys/notifications';
import { approveTrigger, rejectTrigger } from '../database/queries';


export interface TriggerRequest {
    tradeId: string;
    requestId: string;
    triggerType: TriggerType;
    requestHash?: string;
    isRedrive?: boolean;
}

export interface TriggerResponse {
    idempotencyKey: string;
    actionKey: string;
    requestId: string;
    status: TriggerStatus;
    txHash?: string;
    blockNumber?: number;
    message: string;
}

export class TriggerManager {
    private readonly maxBackoffMs = 30000;

    constructor(
        private sdkClient: SDKClient,
        private maxAttempts: number = 5,
        private baseDelayMs: number = 1000,
        private notifier?: WebhookNotifier,
        private manualApprovalEnabled: boolean = false,
    ) {}

    async executeTrigger(request: TriggerRequest): Promise<TriggerResponse> {
        StateValidator.validateTradeId(request.tradeId);

        Logger.info('Processing trigger request', {
            tradeId: request.tradeId,
            requestId: request.requestId,
            triggerType: request.triggerType,
            isRedrive: request.isRedrive || false,
        });

        const actionKey = generateActionKey(request.triggerType, request.tradeId);

        const latestTrigger = await getLatestTriggerByActionKey(actionKey);
        
        if (latestTrigger && this.isActionAlreadyCompleted(latestTrigger)) {
            Logger.info('Action already completed', {
                actionKey,
                status: latestTrigger.status,
                txHash: latestTrigger.tx_hash,
            });
            
            return {
                idempotencyKey: latestTrigger.idempotency_key,
                actionKey,
                requestId: latestTrigger.request_id,
                status: latestTrigger.status,
                txHash: latestTrigger.tx_hash || undefined,
                blockNumber: latestTrigger.block_number ? Number(latestTrigger.block_number) : undefined,
                message: 'Action already completed (idempotent)',
            };
        }

        if (request.isRedrive && latestTrigger?.status === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
            return await this.handleRedrive(latestTrigger, request);
        }

        const existingRequestIdKey = generateIdempotencyKey(actionKey);
        const existingRequest = await getTriggerByIdempotencyKey(existingRequestIdKey);
        
        if (existingRequest) {
            return this.handleExistingTrigger(existingRequest, actionKey);
        }


        try {
            const trade = await this.sdkClient.getTrade(request.tradeId);
            StateValidator.validateTradeState(trade, request.triggerType);

            if (this.manualApprovalEnabled && !request.isRedrive) {
                const trigger = await this.createNewTrigger(request, actionKey);

                await updateTrigger(trigger.idempotency_key, {
                    status: TriggerStatus.PENDING_APPROVAL,
                });

                incrementOraclePendingApproval(actionKey);

                Logger.audit('TRIGGER_PENDING_APPROVAL', request.tradeId, {
                    actionKey,
                    idempotencyKey: trigger.idempotency_key,
                    triggerType: request.triggerType,
                });

                return {
                    idempotencyKey: trigger.idempotency_key,
                    actionKey,
                    requestId: request.requestId,
                    status: TriggerStatus.PENDING_APPROVAL,
                    message: 'Trigger created and awaiting manual approval',
                };
            }

            Logger.info('Trade state validated, creating new trigger', {
                tradeId: request.tradeId,
                triggerType: request.triggerType,
                tradeStatus: trade.status,
                actionKey,
            });

            const trigger = await this.createNewTrigger(request, actionKey);
            return await this.executeWithRetry(trigger, actionKey);
        } catch (error: any) {
            if (
                error?.code === 'CALL_EXCEPTION' ||
                error?.message?.includes('trade not found') ||
                error?.message?.includes('execution reverted')
            ) {
                throw new ValidationError(
                    `Trade ${request.tradeId} does not exist on-chain: ${error?.reason || error?.message}`
                );
            }
            throw error;
        }
    }

    private isActionAlreadyCompleted(trigger: Trigger): boolean {
        return (
            trigger.status === TriggerStatus.CONFIRMED ||
            trigger.status === TriggerStatus.SUBMITTED
        );
    }

    private async handleRedrive(
        exhaustedTrigger: Trigger,
        request: TriggerRequest
    ): Promise<TriggerResponse> {
        Logger.info('Handling re-drive for exhausted trigger', {
            actionKey: exhaustedTrigger.action_key,
            previousAttempts: exhaustedTrigger.attempt_count,
        });
        incrementOracleRedriveAttempts(exhaustedTrigger.action_key);

        try {
            const trade = await this.sdkClient.getTrade(exhaustedTrigger.trade_id);
            StateValidator.validateTradeState(trade, exhaustedTrigger.trigger_type);

            Logger.info('Re-drive check: action still pending, creating new attempt', {
                actionKey: exhaustedTrigger.action_key,
                tradeStatus: trade.status,
            });

            const newRequestId = generateRequestId();
            const newIdempotencyKey = generateIdempotencyKey(exhaustedTrigger.action_key);

            const newTrigger = await createTrigger({
                actionKey: exhaustedTrigger.action_key,
                requestId: newRequestId,
                idempotencyKey: newIdempotencyKey,
                tradeId: exhaustedTrigger.trade_id,
                triggerType: exhaustedTrigger.trigger_type,
                requestHash: request.requestHash || null,
                status: TriggerStatus.PENDING,
            });

            Logger.info('Re-drive trigger created', {
                actionKey: newTrigger.action_key,
                newRequestId: newRequestId.substring(0, 16),
                previousRequestId: exhaustedTrigger.request_id.substring(0, 16),
            });

            return await this.executeWithRetry(newTrigger, exhaustedTrigger.action_key);

        } catch (error: any) {
            if (error instanceof ValidationError) {
                Logger.info('Re-drive check: action already executed on-chain', {
                    actionKey: exhaustedTrigger.action_key,
                    validationError: error.message,
                });

                await updateTrigger(exhaustedTrigger.idempotency_key, {
                    status: TriggerStatus.CONFIRMED,
                    on_chain_verified: true,
                    on_chain_verified_at: new Date(),
                    confirmed_at: new Date()
                });

                return {
                    idempotencyKey: exhaustedTrigger.idempotency_key,
                    actionKey: exhaustedTrigger.action_key,
                    requestId: exhaustedTrigger.request_id,
                    status: TriggerStatus.CONFIRMED,
                    txHash: exhaustedTrigger.tx_hash || undefined,
                    message: 'Action already executed on-chain (verified during re-drive)',
                };
            }

            Logger.error('Re-drive verification failed', {
                actionKey: exhaustedTrigger.action_key,
                error: error.message,
            });
            throw error;
        }
    }

    private handleExistingTrigger(trigger: Trigger, actionKey: string): TriggerResponse {
        Logger.info('Found existing trigger for this request_id', {
            idempotencyKey: trigger.idempotency_key.substring(0, 32),
            actionKey,
            status: trigger.status,
            txHash: trigger.tx_hash,
        });

        if (
            trigger.status === TriggerStatus.CONFIRMED ||
            trigger.status === TriggerStatus.SUBMITTED
        ) {
            return {
                idempotencyKey: trigger.idempotency_key,
                actionKey,
                requestId: trigger.request_id,
                status: trigger.status,
                txHash: trigger.tx_hash || undefined,
                blockNumber: trigger.block_number ? Number(trigger.block_number) : undefined,
                message: 'Trigger already executed for this request (idempotent)',
            };
        }

        if (trigger.status === TriggerStatus.TERMINAL_FAILURE) {
            return {
                idempotencyKey: trigger.idempotency_key,
                actionKey,
                requestId: trigger.request_id,
                status: trigger.status,
                message: trigger.last_error || 'Trigger failed with terminal error',
            };
        }

        if (trigger.status === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
            return {
                idempotencyKey: trigger.idempotency_key,
                actionKey,
                requestId: trigger.request_id,
                status: trigger.status,
                message: 'Trigger exhausted retries. Use re-drive endpoint to retry with on-chain verification.',
            };
        }

        return {
            idempotencyKey: trigger.idempotency_key,
            actionKey,
            requestId: trigger.request_id,
            status: trigger.status,
            message: 'Trigger in progress',
        };
    }

    async resumeAfterApproval(idempotencyKey: string,actor: string): Promise<TriggerResponse> {
        const updated = await approveTrigger(idempotencyKey, actor);

        if (!updated) {
            const existing = await getTriggerByIdempotencyKey(idempotencyKey);
            if (!existing) {
                throw new ValidationError(`Trigger not found: ${idempotencyKey}`);
            }
            return this.buildResponseFromTrigger(existing, 'Trigger already processed');
        }

        incrementOracleApproved(updated.action_key);

        Logger.audit('TRIGGER_APPROVED', updated.trade_id, {
            actionKey: updated.action_key,
            idempotencyKey,
            actor,
            approvedAt: updated.approved_at,
        });

        return this.executeWithRetry(updated, updated.action_key);
    }


    async rejectPendingTrigger(idempotencyKey: string,actor: string,reason?: string): Promise<TriggerResponse> {
        const updated = await rejectTrigger(idempotencyKey, actor, reason);

        if (!updated) {
            const existing = await getTriggerByIdempotencyKey(idempotencyKey);
            if (!existing) {
                throw new ValidationError(`Trigger not found: ${idempotencyKey}`);
            }
            return this.buildResponseFromTrigger(existing, 'Trigger already processed');
        }

        incrementOracleRejected(updated.action_key);

        Logger.audit('TRIGGER_REJECTED', updated.trade_id, {
            actionKey: updated.action_key,
            idempotencyKey,
            actor,
            reason: reason ?? null,
            rejectedAt: updated.rejected_at,
        });

        return this.buildResponseFromTrigger(updated, `Trigger rejected by ${actor}`);
    }

    private buildResponseFromTrigger(trigger: Trigger, message: string): TriggerResponse {
        return {
            idempotencyKey: trigger.idempotency_key,
            actionKey: trigger.action_key,
            requestId: trigger.request_id,
            status: trigger.status,
            txHash: trigger.tx_hash ?? undefined,
            blockNumber: trigger.block_number ? Number(trigger.block_number) : undefined,
            message,
        };
    }


    private async createNewTrigger(
        request: TriggerRequest,
        actionKey: string
    ): Promise<Trigger> {
        const idempotencyKey = generateIdempotencyKey(actionKey);

        const data: CreateTriggerData = {
            actionKey,
            requestId: request.requestId,
            idempotencyKey,
            tradeId: request.tradeId,
            triggerType: request.triggerType,
            requestHash: request.requestHash || null,
            status: TriggerStatus.PENDING,
        };

        return await createTrigger(data);
    }

    private async executeWithRetry(trigger: Trigger, actionKey: string): Promise<TriggerResponse> {
        let attempt = 1;

        while (attempt <= this.maxAttempts) {
            try {
                Logger.info('Executing trigger attempt', {
                    idempotencyKey: trigger.idempotency_key.substring(0, 32),
                    actionKey,
                    attempt,
                    maxAttempts: this.maxAttempts,
                });

                const trade = await this.sdkClient.getTrade(trigger.trade_id);
                StateValidator.validateTradeState(trade, trigger.trigger_type);

                await updateTrigger(trigger.idempotency_key, {
                    status: TriggerStatus.EXECUTING,
                    attempt_count: attempt,
                });

                const result = await this.executeBlockchainAction(
                    trigger.trigger_type,
                    trigger.trade_id
                );

                await updateTrigger(trigger.idempotency_key, {
                    status: TriggerStatus.SUBMITTED,
                    tx_hash: result.txHash,
                    block_number: BigInt(result.blockNumber),
                    submitted_at: new Date(),
                });

                Logger.info('Trigger submitted successfully', {
                    idempotencyKey: trigger.idempotency_key.substring(0, 32),
                    actionKey,
                    txHash: result.txHash,
                    blockNumber: result.blockNumber,
                });

                return {
                    idempotencyKey: trigger.idempotency_key,
                    actionKey,
                    requestId: trigger.request_id,
                    status: TriggerStatus.SUBMITTED,
                    txHash: result.txHash,
                    blockNumber: result.blockNumber,
                    message: 'Transaction submitted, awaiting confirmation',
                };

            } catch (error: any) {
                const oracleError = classifyError(error);

                Logger.error('Trigger execution failed', {
                    idempotencyKey: trigger.idempotency_key.substring(0, 32),
                    actionKey,
                    attempt,
                    errorType: oracleError.errorType,
                    isTerminal: oracleError.isTerminal,
                    message: oracleError.message,
                });

                const nextStatus = determineNextStatus(
                    oracleError,
                    attempt,
                    this.maxAttempts
                );

                await updateTrigger(trigger.idempotency_key, {
                    status: nextStatus,
                    attempt_count: attempt,
                    last_error: oracleError.message,
                    error_type: oracleError.errorType,
                });

                if (nextStatus === TriggerStatus.TERMINAL_FAILURE) {
                    await this.notifyTerminalStatus(trigger, actionKey, nextStatus, oracleError.message, attempt);
                    return {
                        idempotencyKey: trigger.idempotency_key,
                        actionKey,
                        requestId: trigger.request_id,
                        status: nextStatus,
                        message: oracleError.message,
                    };
                }

                if (nextStatus === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
                    const exhaustedMessage =
                        "Exhausted " + this.maxAttempts + " attempts: " + oracleError.message + ". Use re-drive endpoint to retry.";
                    incrementOracleExhaustedRetries(actionKey);
                    await this.notifyTerminalStatus(trigger, actionKey, nextStatus, exhaustedMessage, attempt);
                    return {
                        idempotencyKey: trigger.idempotency_key,
                        actionKey,
                        requestId: trigger.request_id,
                        status: nextStatus,
                        message: exhaustedMessage,
                    };
                }

                if (attempt < this.maxAttempts && !oracleError.isTerminal) {
                    const backoffMs = calculateBackoff(attempt, this.baseDelayMs, this.maxBackoffMs);
                    Logger.info('Retrying after backoff', {
                        idempotencyKey: trigger.idempotency_key.substring(0, 32),
                        actionKey,
                        backoffMs,
                        maxBackoffMs: this.maxBackoffMs,
                        nextAttempt: attempt + 1,
                    });
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    attempt++;
                    continue;
                }

                throw error;
            }
        }

        throw new Error(`Retry loop exited without terminal status for action ${actionKey} after ${this.maxAttempts} attempts`);
    }

    private async notifyTerminalStatus(
        trigger: Trigger,
        actionKey: string,
        status: TriggerStatus,
        message: string,
        attempt: number
    ): Promise<void> {
        if (!this.notifier) {
            return;
        }

        const eventType =
            status === TriggerStatus.TERMINAL_FAILURE
                ? 'ORACLE_TRIGGER_TERMINAL_FAILURE'
                : 'ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE';

        await this.notifier.notify({
            source: 'oracle',
            type: eventType,
            severity: 'critical',
            dedupKey: 'oracle:' + status + ':' + actionKey,
            message,
            correlation: {
                tradeId: trigger.trade_id,
                actionKey,
                requestId: trigger.request_id,
                txHash: trigger.tx_hash || undefined,
            },
            metadata: {
                triggerType: trigger.trigger_type,
                status,
                attempt,
                maxAttempts: this.maxAttempts,
            },
        });
    }

    private async executeBlockchainAction(
        triggerType: TriggerType,
        tradeId: string
    ): Promise<BlockchainResult> {
        switch (triggerType) {
            case TriggerType.RELEASE_STAGE_1:
                return await this.sdkClient.releaseFundsStage1(tradeId);

            case TriggerType.CONFIRM_ARRIVAL:
                return await this.sdkClient.confirmArrival(tradeId);

            case TriggerType.FINALIZE_TRADE:
                return await this.sdkClient.finalizeTrade(tradeId);

            default:
                throw new Error(`Unknown trigger type: ${triggerType}`);
        }
    }
}
