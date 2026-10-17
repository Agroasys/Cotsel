/** SPDX-License-Identifier: Apache-2.0 */
import type {
  GaslessCreateTradeExecutionResult,
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
): Promise<GaslessCreateTradeExecutionResult> {
  await validateBoundUserAction(
    input,
    (id) => context.store.getHandoff(id),
    context.usdcAddress,
    context.verifyUserActionFunding,
  );
  return requireReviewedUserActionCapability();
}
