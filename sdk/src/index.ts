/**
 * SPDX-License-Identifier: Apache-2.0
 */
// 3 SDK roles
export { BuyerSDK } from './modules/buyerSDK';
export { AdminSDK } from './modules/adminSDK';
export { OracleSDK } from './modules/oracleSDK';

// ricardian helper
export { RicardianClient } from './modules/ricardianClient';

// service-to-service auth helper
export { createServiceAuthHeaders, buildServiceAuthCanonicalString, signServiceAuthCanonicalString } from './modules/serviceAuth';
export { createManagedRpcProvider } from './rpc/failoverProvider';

// types
export * from './types/trade';
export * from './types/dispute';
export * from './types/governance';
export * from './types/oracle';
export * from './types/ricardian';
export * from './types/errors';

// config
export * from './config';

// utils
export * from './utils/validation';
export * from './utils/signature';

// web3auth
export { web3Wallet } from './wallet/wallet-provider';

export { AuthClient } from './modules/authClient';
export type { AuthClientConfig, AuthRole, SessionResult, LoginOptions } from './modules/authClient';
