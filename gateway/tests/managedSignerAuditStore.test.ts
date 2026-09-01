/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import {
  createPostgresManagedSignerAuditStore,
  createPostgresManagedSignerValidationRecorder,
} from '../src/core/managedSignerAuditStore';
import { Logger } from '../src/logging/logger';

test('appends privacy-safe signer validation evidence without raw transaction data', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const store = createPostgresManagedSignerAuditStore({ query } as unknown as Pool);

  await store.append(
    {
      requestId: 'signer-request-1',
      intentHash: `0x${'1'.repeat(64)}`,
      signedTransactionHash: `0x${'2'.repeat(64)}`,
      signerAddress: '0x00000000000000000000000000000000000000A1',
      nonce: 7,
      transactionType: 2,
      outcome: 'accepted',
    },
    {
      operation: 'create_trade',
      applicationRequestId: 'application-request-1',
      resourceId: 'handoff-1',
    },
  );

  expect(query).toHaveBeenCalledTimes(1);
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain('INSERT INTO managed_signer_validation_audit');
  expect(sql).not.toContain('signed_transaction,');
  expect(values).toEqual([
    'signer-request-1',
    'application-request-1',
    'handoff-1',
    'create_trade',
    `0x${'1'.repeat(64)}`,
    `0x${'2'.repeat(64)}`,
    '0x00000000000000000000000000000000000000A1',
    7,
    2,
    'accepted',
    null,
  ]);
});

test('emits an operator-visible rejection signal only after durable evidence is appended', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const warn = jest.spyOn(Logger, 'warn').mockImplementation();
  const recorder = createPostgresManagedSignerValidationRecorder({
    query,
  } as unknown as Pool);

  await recorder(
    {
      requestId: 'signer-request-2',
      intentHash: `0x${'3'.repeat(64)}`,
      signedTransactionHash: `0x${'4'.repeat(64)}`,
      signerAddress: '0x00000000000000000000000000000000000000A1',
      nonce: 8,
      transactionType: 2,
      outcome: 'rejected',
      failureReason: 'calldata',
    },
    {
      operation: 'create_trade',
      applicationRequestId: 'application-request-2',
      resourceId: 'handoff-2',
    },
  );

  expect(query.mock.invocationCallOrder[0]).toBeLessThan(warn.mock.invocationCallOrder[0]);
  expect(warn).toHaveBeenCalledWith(
    'Managed signer transaction rejected before broadcast',
    expect.objectContaining({
      requestId: 'signer-request-2',
      applicationRequestId: 'application-request-2',
      failureReason: 'calldata',
    }),
  );
  warn.mockRestore();
});
