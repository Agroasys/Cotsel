/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { createAdminControlApiKeyLookup } from '../src/core/adminControlIdentity';

const validKeys = JSON.stringify([
  {
    id: 'admin-control-a',
    secret: 'secret-a',
    active: true,
    humanPrincipalId: 'agroasys-user:operator-a',
  },
  {
    id: 'admin-control-b',
    secret: 'secret-b',
    active: true,
    humanPrincipalId: 'agroasys-user:operator-b',
  },
]);

describe('admin control identity configuration', () => {
  test('returns only allowed credentials with authenticated human principals', () => {
    const lookup = createAdminControlApiKeyLookup(validKeys, [
      'admin-control-a',
      'admin-control-b',
    ]);

    expect(lookup('admin-control-a')).toMatchObject({
      id: 'admin-control-a',
      humanPrincipalId: 'agroasys-user:operator-a',
    });
    expect(lookup('unknown')).toBeUndefined();
  });

  test('rejects missing or ambiguous human separation-of-duties configuration', () => {
    expect(() =>
      createAdminControlApiKeyLookup(
        JSON.stringify([
          { id: 'a', secret: 'a', active: true },
          {
            id: 'b',
            secret: 'b',
            active: true,
            humanPrincipalId: 'agroasys-user:operator-b',
          },
        ]),
        ['a', 'b'],
      ),
    ).toThrow('requires humanPrincipalId');

    expect(() =>
      createAdminControlApiKeyLookup(
        JSON.stringify([
          {
            id: 'a',
            secret: 'a',
            active: true,
            humanPrincipalId: 'agroasys-user:operator-a',
          },
          {
            id: 'b',
            secret: 'b',
            active: true,
            humanPrincipalId: 'agroasys-user:operator-a',
          },
        ]),
        ['a', 'b'],
      ),
    ).toThrow('two distinct active human principals');
  });

  test('rejects duplicate or missing allowed credential IDs', () => {
    const duplicate = JSON.stringify([
      {
        id: 'a',
        secret: 'first',
        active: true,
        humanPrincipalId: 'agroasys-user:operator-a',
      },
      {
        id: 'a',
        secret: 'second',
        active: true,
        humanPrincipalId: 'agroasys-user:operator-b',
      },
    ]);
    expect(() => createAdminControlApiKeyLookup(duplicate, ['a'])).toThrow('duplicate key ID');
    expect(() => createAdminControlApiKeyLookup(validKeys, ['admin-control-a', 'missing'])).toThrow(
      'is not configured',
    );
  });
});
