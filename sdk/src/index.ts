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

// Legacy wallet/session helpers. Prefer an Agroasys-managed signer path.
/**
 * @deprecated Use an Agroasys-managed embedded-wallet signer and pass it into
 * BuyerSDK/AdminSDK/OracleSDK methods.
 */
export { web3Wallet } from './wallet/wallet-provider';

/**
 * @deprecated Use Agroasys auth plus an Agroasys-managed embedded-wallet
 * bootstrap flow instead of SDK-owned wallet challenge auth.
 */
export { AuthClient } from './modules/authClient';
export type { AuthClientConfig, AuthRole, SessionResult, LoginOptions } from './modules/authClient';
