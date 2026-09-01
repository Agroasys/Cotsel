import type { Pool } from 'pg';
import { createPostgresManagedSignerAuditStore } from './managed-signer-audit-store';

test('appends a rejected signer validation without retaining raw signer output', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const store = createPostgresManagedSignerAuditStore({ query } as unknown as Pool);

  await store.append({
    requestId: 'oracle-signer-request-1',
    intentHash: `0x${'1'.repeat(64)}`,
    signedTransactionHash: `0x${'2'.repeat(64)}`,
    signerAddress: '0x00000000000000000000000000000000000000A1',
    nonce: 9,
    transactionType: 2,
    outcome: 'rejected',
    failureReason: 'calldata',
  });

  expect(query).toHaveBeenCalledTimes(1);
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain('INSERT INTO managed_signer_validation_audit');
  expect(sql).not.toContain('signed_transaction,');
  expect(values).toEqual([
    'oracle-signer-request-1',
    `0x${'1'.repeat(64)}`,
    `0x${'2'.repeat(64)}`,
    '0x00000000000000000000000000000000000000A1',
    9,
    2,
    'rejected',
    'calldata',
  ]);
});
