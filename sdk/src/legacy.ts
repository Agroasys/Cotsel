/**
 * SPDX-License-Identifier: Apache-2.0
 */
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
export type {
  AuthClientConfig,
  AuthRole,
  SessionResult,
  LoginOptions,
} from './modules/authClient';
