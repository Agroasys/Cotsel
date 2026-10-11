/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ExchangeAuthority } from '../../src/core/exchangeAuthority';

/** An exchange key permitted every role and any organization. */
export const ANY_ROLE_AUTHORITY: ExchangeAuthority = {
  keyId: 'exchange-test',
  roles: ['buyer', 'supplier', 'admin'],
  orgId: null,
};
