/** SPDX-License-Identifier: Apache-2.0 */
import type {
  GaslessCreateTradeExecutionResult,
  GaslessUserActionExecutionInput,
} from './gaslessExecutionTypes';
import { requireReviewedUserActionCapability } from './gaslessExecutionValidation';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';

/** Compatibility containment: no accepted event, simulation, reservation, signing, or dispatch. */
export async function executeUserActionWorkflow(
  _context: GaslessWorkflowContext,
  _input: GaslessUserActionExecutionInput,
): Promise<GaslessCreateTradeExecutionResult> {
  return requireReviewedUserActionCapability();
}
