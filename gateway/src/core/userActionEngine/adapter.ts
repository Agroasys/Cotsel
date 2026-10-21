import { validateBoundUserAction } from '../gaslessExecutionValidation';
/** SPDX-License-Identifier: Apache-2.0 */
import type { Pool } from 'pg';
import type {
  GaslessUserActionExecutionInput,
  GaslessUserActionExecutionResult,
} from '../gaslessExecutionTypes';
import type { GaslessWorkflowContext } from '../gaslessWorkflowContext';
import type { SettlementService } from '../settlementService';
import type { SettlementStore } from '../settlementStore';
import type { UserActionFundingVerifier } from '../userActionFundingVerification';
import { GatewayError } from '../../errors';
import { createUserActionRequestStore } from './requestStore';
import { verifyNonceOwnership, type VerifyUserActionRetirement } from './retirement';
import { prepareUserActionCustody, type UserActionCustodyPorts } from './custody';
import { executeDormantUserAction } from './workflow';
import { assertDormantAction, requestIdentity, verifyUserAction } from './validation';
export interface UserActionExecutionAdapter {
  isCommittedReplay(input: GaslessUserActionExecutionInput): Promise<boolean>;
  simulate(input: GaslessUserActionExecutionInput): Promise<{ gasEstimate: bigint }>;
  execute(input: GaslessUserActionExecutionInput): Promise<GaslessUserActionExecutionResult>;
}
export interface UserActionAdapterBinding extends UserActionExecutionAdapter {
  bindCustody(ports: UserActionCustodyPorts): void;
  bindRuntime(context: GaslessWorkflowContext): void;
}
export interface OwnedUserActionAdapterDependencies {
  pool: Pool;
  store: SettlementStore;
  settlementService: SettlementService;
  verifyFunding: UserActionFundingVerifier;
  verifyRetirement: VerifyUserActionRetirement | undefined;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  requestMaxTtlSeconds: number;
}
function unavailable(): never {
  throw new GatewayError(
    503,
    'UPSTREAM_UNAVAILABLE',
    'Bound user-action execution is unavailable',
    { reason: 'user_action_execution_unavailable' },
  );
}
/** Production-owned binding; construction/binding confers no activation permission. */
export function createOwnedUserActionAdapter(
  dependencies: OwnedUserActionAdapterDependencies,
): UserActionAdapterBinding {
  let custody: UserActionCustodyPorts | undefined, runtime: GaslessWorkflowContext | undefined;
  const ports = () => {
    if (!custody || !runtime || !dependencies.verifyRetirement) return unavailable();
    const context = runtime;
    return {
      ...dependencies,
      now: context.now,
      loadHandoff: (id: string) => dependencies.store.getHandoff(id),
      verifyFunding: dependencies.verifyFunding,
      verifyNonceOwnership: (input: GaslessUserActionExecutionInput) =>
        verifyNonceOwnership(dependencies.pool, input, dependencies.verifyRetirement!, () =>
          context.now().getTime(),
        ),
      requests: createUserActionRequestStore(dependencies.pool, 60, () => context.now().getTime()),
      settlementService: dependencies.settlementService,
      custody: {
        ...custody,
        observeBalance: (balance: bigint) => context.recordExecutorBalance?.(balance),
      },
      assertBroadcastOpen: context.assertBroadcastOpen,
      assertCapacityOpen: context.assertCapacityOpen,
      enqueueBroadcast: context.enqueueBroadcast,
    };
  };
  return {
    async isCommittedReplay(input) {
      try {
        assertDormantAction(input);
        if (!input.sourceApiKeyId || !input.sourceOperationId) return false;
        const requests = createUserActionRequestStore(dependencies.pool);
        const record = await requests.inspect(input.sourceApiKeyId, input.sourceOperationId);
        return record?.status === 'signing' && (await requests.matches(input));
      } catch {
        return unavailable();
      }
    },
    bindCustody(value) {
      if (custody) throw new Error('User-action custody already bound');
      custody = value;
    },
    bindRuntime(value) {
      if (runtime) throw new Error('User-action runtime already bound');
      runtime = value;
    },
    async simulate(input) {
      try {
        assertDormantAction(input);
        const context = ports();
        await verifyUserAction(context, input);
        context.assertBroadcastOpen(input.action);
        const prepared = await prepareUserActionCustody(
          context.custody,
          input,
          input.sourceOperationId!,
        );
        context.assertCapacityOpen(input.action);
        return { gasEstimate: prepared.gasEstimate };
      } catch {
        return unavailable();
      }
    },
    async execute(input) {
      try {
        assertDormantAction(input);
        const requests = createUserActionRequestStore(dependencies.pool);
        const observe = async () => {
          const record =
            input.sourceApiKeyId && input.sourceOperationId
              ? await requests.inspect(input.sourceApiKeyId, input.sourceOperationId)
              : null;
          return record?.status === 'signing' && (await requests.matches(input));
        };
        let replay;
        if (await observe()) {
          await validateBoundUserAction(
            input,
            (id) => dependencies.store.getHandoff(id),
            dependencies.usdcAddress,
            undefined,
            observe,
          );
          replay = (await requests.inspect(input.sourceApiKeyId!, input.sourceOperationId!))!;
        } else replay = await executeDormantUserAction(ports(), input);
        const hashes = replay.attempts
          .filter((attempt) => attempt.eventType === 'signed')
          .map((attempt) => attempt.transactionHash);
        if (hashes.length > 1) return unavailable();
        return {
          schemaVersion: 'cotsel.user-action-execution.v1',
          requestId: replay.requestId,
          sourceOperationId: input.sourceOperationId!,
          actionPackageId: input.actionPackageId!,
          handoffId: input.handoffId,
          action: input.action,
          requestFingerprint: requestIdentity(input).fingerprint,
          executionStatus: replay.status,
          transactionHash: hashes[0] ?? null,
          attempts: replay.attempts,
          outcomes: replay.outcomes,
        };
      } catch {
        return unavailable();
      }
    },
  };
}
export function requireUserActionAdapter(
  adapter: UserActionExecutionAdapter | undefined,
): UserActionExecutionAdapter {
  return adapter ?? unavailable();
}
