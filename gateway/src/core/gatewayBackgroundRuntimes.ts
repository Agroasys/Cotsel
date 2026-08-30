/**
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GatewayBackgroundRuntime {
  start(): void;
  stop(): void;
}

export function startGatewayBackgroundRuntimes(
  runtimes: Array<GatewayBackgroundRuntime | null | undefined>,
): () => void {
  const active = runtimes.filter((runtime): runtime is GatewayBackgroundRuntime =>
    Boolean(runtime),
  );
  active.forEach((runtime) => runtime.start());
  return () => active.forEach((runtime) => runtime.stop());
}
