/**
 * RPC startup reachability checks.
 *
 * The implementation lives in the SDK so every Cotsel service shares one
 * "pass when at least one endpoint is reachable" preflight. Re-exported here to
 * keep existing imports (cli, tests) stable.
 */
export {
  assertRpcEndpointReachable,
  assertRpcEndpointsReachable,
  redactRpcUrlForLogs,
  selectReachableRpcEndpoint,
} from '@agroasys/sdk';
