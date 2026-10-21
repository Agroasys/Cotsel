/** SPDX-License-Identifier: Apache-2.0 */
// Invoked only by owning adapters behind unconditional public activation denials.
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import type { SettlementService } from '../settlementService';
import type { SettlementEventType, SettlementExecutionStatus } from '../settlementStore';
import {
  isGaslessTransactionOutcomePendingError,
  isGaslessTransactionRevertedError,
} from '../gaslessTransactionLifecycle';
import { prepareUserActionCustody, type UserActionCustodyPorts } from './custody';
import type { UserActionRequestStore, UserActionReplay } from './requestStore';
import {
  assertDormantAction,
  deny,
  requestIdentity,
  verifyUserAction,
  type UserActionValidationPorts,
} from './validation';
export interface DormantUserActionEnginePorts extends UserActionValidationPorts {
  requests: UserActionRequestStore;
  enqueueBroadcast?<T>(operation: () => Promise<T>): Promise<T>;
  custody: UserActionCustodyPorts;
  settlementService: Pick<SettlementService, 'recordExecutionEvent'>;
  assertBroadcastOpen(action: string): void;
  assertCapacityOpen(action: string): void;
}
/** Internal controlled engine. It confers no activation authority. */
export async function executeDormantUserAction(
  ports: DormantUserActionEnginePorts,
  input: GaslessUserActionExecutionInput,
): Promise<UserActionReplay> {
  assertDormantAction(input);
  if (!input.sourceApiKeyId || !input.sourceOperationId)
    deny('Owned user-action operation is required');
  // Owner-scoped replay does not depend on an expired signature becoming valid again.
  const existing = await ports.requests.inspect(input.sourceApiKeyId, input.sourceOperationId);
  if (existing?.status === 'signing') {
    // Compare exact signature/deadline/nonce body even for replay; never consume changed input.
    return replayExact(ports, input, existing);
  }
  const witness = await verifyUserAction(ports, input);
  const request = await ports.requests.accept(input, witness);
  if (request.requestFingerprint !== requestIdentity(input).fingerprint) deny();
  if (request.status === 'signing')
    return (await ports.requests.inspect(input.sourceApiKeyId, input.sourceOperationId))!;
  const claim = await ports.requests.claim(request);
  const project = async (
    eventType: SettlementEventType,
    status: SettlementExecutionStatus,
    txHash?: string,
  ) => {
    await ports.settlementService.recordExecutionEvent({
      handoffId: input.handoffId,
      eventType,
      executionStatus: status,
      reconciliationStatus: 'pending',
      providerStatus: `gasless_user_action_${eventType}`,
      detail: 'Bound user-action execution evidence.',
      metadata: {
        action: input.action,
        packageId: input.actionPackageId,
        sourceOperationId: input.sourceOperationId,
        payloadHash: input.payloadHash,
      },
      observedAt: ports.now().toISOString(),
      requestId: request.requestId,
      sourceApiKeyId: input.sourceApiKeyId,
      txHash,
    });
  };
  await project('accepted', 'accepted');
  await project('queued', 'queued');
  ports.assertBroadcastOpen(input.action);
  ports.assertCapacityOpen(input.action);
  const run = async () => {
    const prepared = await prepareUserActionCustody(ports.custody, input, request.requestId);
    await project('simulation_completed', 'queued');
    const fresh = await verifyUserAction(ports, input);
    try {
      const result = await prepared.execute(
        async () => {
          ports.assertBroadcastOpen(input.action);
          ports.assertCapacityOpen(input.action);
          await ports.requests.beginSigning(input, fresh, claim);
        },
        (identity) => ports.requests.recordSigned(claim, identity),
        (type, hash) => ports.requests.recordHash(claim, type, hash),
      );
      await project('submitted', 'submitted', result.txHash);
      if (result.confirmed) await project('confirmed', 'confirmed', result.txHash);
    } catch (error) {
      if (isGaslessTransactionOutcomePendingError(error))
        await project(error.outcome, error.outcome, error.transactionHash);
      else if (isGaslessTransactionRevertedError(error)) {
        await project('confirmation_pending', 'confirmation_pending', error.transactionHash);
        await project('reverted', 'reverted', error.transactionHash);
      } else throw error;
    }
  };
  if (ports.enqueueBroadcast) await ports.enqueueBroadcast(run);
  else await run();
  return (await ports.requests.inspect(input.sourceApiKeyId, input.sourceOperationId))!;
}
async function replayExact(
  ports: DormantUserActionEnginePorts,
  input: GaslessUserActionExecutionInput,
  replay: UserActionReplay,
): Promise<UserActionReplay> {
  if (!(await ports.requests.matches(input)))
    deny('User-action replay conflicts with original request');
  return replay;
}
