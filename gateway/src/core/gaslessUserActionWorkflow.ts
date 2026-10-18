import { requireUserActionAdapter } from './userActionEngine/adapter';
/** SPDX-License-Identifier: Apache-2.0 */
import type {
  GaslessUserActionExecutionResult,
  GaslessUserActionExecutionInput,
} from './gaslessExecutionTypes';
import {
  requireReviewedUserActionCapability,
  validateBoundUserAction,
} from './gaslessExecutionValidation';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';
/** No accepted event, simulation, reservation, signing, or dispatch while activation is blocked. */
export async function executeUserActionWorkflow(
  context: GaslessWorkflowContext,
  input: GaslessUserActionExecutionInput,
): Promise<GaslessUserActionExecutionResult> {
  await validateBoundUserAction(
    input,
    (id) => context.store.getHandoff(id),
    context.usdcAddress,
    context.verifyUserActionFunding,
    context.userActionAdapter?.isCommittedReplay,
  );
  requireReviewedUserActionCapability();
  return requireUserActionAdapter(context.userActionAdapter).execute(input);
}
