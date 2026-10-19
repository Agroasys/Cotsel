/** SPDX-License-Identifier: Apache-2.0 */
import type { GatewayConfig } from './gatewayConfig';
export const USER_ACTION_RETIREMENT_PATH =
  '/api/v1/settlement-handoffs/cotsel/lifecycle-action-retirement-evidence';
/** Missing or malformed dependency disables this capability only; values never authorize execution. */
export function resolveUserActionRetirementDependency(
  config: Pick<
    GatewayConfig,
    | 'userActionRetirementEvidenceUrl'
    | 'userActionRetirementOwningServiceId'
    | 'settlementCallbackApiKey'
    | 'settlementCallbackApiSecret'
  >,
): { url: string; owningServiceId: string } | undefined {
  const raw = config.userActionRetirementEvidenceUrl;
  const owner = config.userActionRetirementOwningServiceId;
  if (
    !raw ||
    !owner ||
    !config.settlementCallbackApiKey ||
    !config.settlementCallbackApiSecret ||
    !/^\S{1,128}$/.test(owner)
  )
    return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== USER_ACTION_RETIREMENT_PATH ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      raw !== raw.trim()
    )
      return undefined;
    return { url: url.toString(), owningServiceId: owner };
  } catch {
    return undefined;
  }
}
