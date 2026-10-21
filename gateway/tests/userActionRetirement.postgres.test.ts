import { executeDormantUserAction } from '../src/core/userActionEngine/workflow';
import { recoverUserActionSignedIdentities } from '../src/core/userActionEngine/recoverSignedIdentity';
import { createPostgresGaslessTransactionOutcomeRecorder } from '../src/core/gaslessTransactionOutcomeStore';
/** SPDX-License-Identifier: Apache-2.0 */
import { createUserActionEnginePostgres } from './helpers/userActionEnginePostgres';
import { userActionEngineFixture } from './helpers/userActionEngineFixture';
import {
  verifyNonceOwnership,
  type UserActionRetirementScope,
  type UserActionRetirementEvidence,
} from '../src/core/userActionEngine/retirement';
import { verifyUserAction } from '../src/core/userActionEngine/validation';
const describeLocal =
  process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES === 'true' ? describe : describe.skip;
function evidence(scope: UserActionRetirementScope): UserActionRetirementEvidence {
  return {
    scope,
    anchor: {
      chainId: 84532,
      blockNumber: '200',
      blockHash: '0x' + 'a'.repeat(64),
      timestamp: '2000000001',
    },
    authorizationNonce: '9',
    financialOutcome: {
      authority: 'settlement',
      evidenceId: 'controlled-actual-outcome',
      fingerprint: '0x' + 'b'.repeat(64),
      originalFundingFingerprint: scope.originalFundingFingerprint,
      kind: 'oracle_resolved_without_user_execution',
      transactionHash: '0x' + 'c'.repeat(64),
      blockNumber: '150',
      blockHash: '0x' + 'd'.repeat(64),
    },
  };
}
describeLocal(
  'dormant nonce retirement and successor dependency (controlled owning-domain verifier)',
  () => {
    jest.setTimeout(120_000);
    let db: Awaited<ReturnType<typeof createUserActionEnginePostgres>>;
    beforeEach(async () => {
      db = await createUserActionEnginePostgres();
    });
    afterEach(async () => {
      await db.close();
    });
    async function setup(signing = false) {
      const predecessor = await userActionEngineFixture(db.runtime);
      const witness = await verifyUserAction(predecessor.ports, predecessor.input);
      const request = await predecessor.requests.accept(predecessor.input, witness);
      if (signing) {
        const claim = await predecessor.requests.claim(request);
        await predecessor.requests.beginSigning(
          predecessor.input,
          await verifyUserAction(predecessor.ports, predecessor.input),
          claim,
        );
      }
      const successor = await userActionEngineFixture(
        db.runtime,
        'refund_in_transit_timeout',
        'raw',
        'successor',
        '2000000600',
      );
      const verifier = jest.fn(async (scope: UserActionRetirementScope) => ({
        status: 'verified' as const,
        evidence: evidence(scope),
      }));
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, verifier);
      return { predecessor, successor, request, verifier };
    }
    test.each([false, true])(
      'expired prior request signing=%s permits successor only with independently resolved original obligation and unchanged nonce',
      async (signing) => {
        const { predecessor, successor, request, verifier } = await setup(signing);
        const next = await successor.requests.accept(
          successor.input,
          await verifyUserAction(successor.ports, successor.input),
        );
        expect(next.requestId).not.toBe(request.requestId);
        expect(
          (await db.runtime.query('SELECT request_id FROM gasless_user_action_nonce_owners'))
            .rows[0].request_id,
        ).toBe(next.requestId);
        expect(
          (await db.runtime.query('SELECT request_id FROM gasless_user_action_requests')).rowCount,
        ).toBe(2);
        expect(
          (await db.runtime.query('SELECT event_type FROM gasless_user_action_retirement_events'))
            .rows,
        ).toEqual([{ event_type: 'retired' }]);
        const claim = await successor.requests.claim(next);
        await successor.requests.beginSigning(
          successor.input,
          await verifyUserAction(successor.ports, successor.input),
          claim,
        );
        expect(verifier).toHaveBeenCalledTimes(2);
        expect(predecessor.sign).not.toHaveBeenCalled();
        expect(successor.sign).not.toHaveBeenCalled();
      },
    );
    test.each(['unavailable', 'contradicted'] as const)(
      '%s owner evidence blocks despite local expiry or ambiguous signing',
      async (status) => {
        const { successor } = await setup(true);
        successor.ports.verifyNonceOwnership = (input) =>
          verifyNonceOwnership(db.runtime, input, async () => ({ status }));
        await expect(verifyUserAction(successor.ports, successor.input)).rejects.toThrow(
          'retirement evidence',
        );
        expect(
          (await db.runtime.query('SELECT request_id FROM gasless_user_action_requests')).rowCount,
        ).toBe(1);
      },
    );
    test.each([
      'inclusive_deadline',
      'changed_nonce',
      'wrong_funding',
      'unknown_outcome',
      'oracle_without_tx',
      'wrong_package',
      'outcome_after_anchor',
    ] as const)('%s cannot authorize nonce reuse', async (fault) => {
      const { successor } = await setup();
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async (scope) => {
          const proof = evidence(scope);
          if (fault === 'inclusive_deadline') proof.anchor.timestamp = scope.deadline;
          if (fault === 'changed_nonce') proof.authorizationNonce = '10';
          if (fault === 'wrong_funding')
            proof.financialOutcome.originalFundingFingerprint = 'f'.repeat(64);
          if (fault === 'unknown_outcome') proof.financialOutcome.kind = 'pending' as never;
          if (fault === 'oracle_without_tx') proof.financialOutcome.transactionHash = null;
          if (fault === 'wrong_package') proof.scope = { ...scope, packageId: 'foreign' };
          if (fault === 'outcome_after_anchor') proof.financialOutcome.blockNumber = '201';
          return { status: 'verified', evidence: proof };
        });
      await expect(verifyUserAction(successor.ports, successor.input)).rejects.toThrow('invalid');
    });
    test('independent resolved non-execution uses no invented payout hash', async () => {
      const { successor } = await setup();
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async (scope) => {
          const proof = evidence(scope);
          proof.financialOutcome.kind = 'independent_resolved_non_execution';
          proof.financialOutcome.transactionHash = null;
          return { status: 'verified', evidence: proof };
        });
      await expect(
        successor.requests.accept(
          successor.input,
          await verifyUserAction(successor.ports, successor.input),
        ),
      ).resolves.toMatchObject({ status: 'accepted' });
    });
    test('contradiction after retirement persists drift and fences successor before signing', async () => {
      const { successor } = await setup();
      const next = await successor.requests.accept(
        successor.input,
        await verifyUserAction(successor.ports, successor.input),
      );
      await successor.requests.claim(next);
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async () => ({ status: 'contradicted' }));
      await expect(verifyUserAction(successor.ports, successor.input)).rejects.toThrow(
        'retirement evidence',
      );
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async (scope) => ({
          status: 'verified',
          evidence: evidence(scope),
        }));
      await expect(verifyUserAction(successor.ports, successor.input)).rejects.toThrow(
        'canonical drift',
      );
      expect(
        (
          await db.runtime.query(
            'SELECT event_type FROM gasless_user_action_retirement_events ORDER BY event_id',
          )
        ).rows,
      ).toEqual([{ event_type: 'retired' }, { event_type: 'drift' }]);
      expect(successor.sign).not.toHaveBeenCalled();
    });
    test('changed predecessor attempt invalidates exact retirement witness before owner swap', async () => {
      const { successor, predecessor, request } = await setup();
      const witness = await verifyUserAction(successor.ports, successor.input);
      await predecessor.requests.claim(request);
      await expect(successor.requests.accept(successor.input, witness)).rejects.toThrow(
        'ownership preflight changed',
      );
      expect(
        (await db.runtime.query('SELECT request_id FROM gasless_user_action_nonce_owners')).rows[0]
          .request_id,
      ).toBe(request.requestId);
    });
    test('runtime service isolation and owner guard reject direct deletion/reassignment without retirement', async () => {
      const { predecessor, request } = await setup();
      await expect(
        db.runtime.query(
          "UPDATE gasless_user_action_nonce_owners SET user_address='0x1111111111111111111111111111111111111111'",
        ),
      ).rejects.toThrow('scope_mismatch');
      await expect(db.owner.query('DELETE FROM gasless_user_action_nonce_owners')).rejects.toThrow(
        'delete_forbidden',
      );
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.service_name='oracle'");
        for (const table of [
          'gasless_user_action_requests',
          'gasless_user_action_attempt_events',
          'gasless_user_action_nonce_owners',
          'gasless_user_action_retirement_events',
        ])
          expect((await client.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
        await expect(
          client.query(
            "INSERT INTO gasless_user_action_attempt_events(request_id,event_type) VALUES($1,'accepted')",
            [request.requestId],
          ),
        ).rejects.toThrow('row-level security');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(
        await predecessor.requests.inspect('other', predecessor.input.sourceOperationId!),
      ).toBeNull();
    });
    test('later progression supplies every prior anchor and slow first proof cannot start a later verification', async () => {
      const { successor } = await setup();
      await successor.requests.accept(
        successor.input,
        await verifyUserAction(successor.ports, successor.input),
      );
      const final = await userActionEngineFixture(
        db.runtime,
        'cancel_locked_timeout',
        'raw',
        'third',
        '2000001200',
      );
      const verify = jest.fn(async (scope: UserActionRetirementScope) => ({
        status: 'verified' as const,
        evidence: {
          ...evidence(scope),
          anchor: { ...evidence(scope).anchor, timestamp: '2000000601' },
        },
      }));
      final.ports.verifyNonceOwnership = (input) => verifyNonceOwnership(db.runtime, input, verify);
      await final.requests.accept(final.input, await verifyUserAction(final.ports, final.input));
      expect(verify.mock.calls.some(([scope]) => scope.priorRetirements.length === 1)).toBe(true);
      let now = 0;
      const slow = jest.fn(async (scope: UserActionRetirementScope) => {
        now += 10_001;
        return { status: 'verified' as const, evidence: evidence(scope) };
      });
      await expect(verifyNonceOwnership(db.runtime, final.input, slow, () => now)).rejects.toThrow(
        'expired',
      );
      expect(slow).toHaveBeenCalledTimes(1);
    });
    test('unexpected proof fields never enter retained evidence history', async () => {
      const { successor } = await setup();
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async (scope) => ({
          status: 'verified',
          evidence: {
            ...evidence(scope),
            signature: 'should-not-persist',
          } as UserActionRetirementEvidence,
        }));
      await expect(verifyUserAction(successor.ports, successor.input)).rejects.toThrow('invalid');
      expect(
        (await db.runtime.query('SELECT * FROM gasless_user_action_retirement_events')).rowCount,
      ).toBe(0);
    });
    test('changed independently observed outcome rejects a stale successor retirement snapshot', async () => {
      const predecessor = await userActionEngineFixture(db.runtime);
      predecessor.ports.custody.outcomes.recordPrepared = async () => {
        throw new Error('persist failed');
      };
      await expect(executeDormantUserAction(predecessor.ports, predecessor.input)).rejects.toThrow(
        'persist failed',
      );
      const outcomes = createPostgresGaslessTransactionOutcomeRecorder(db.runtime);
      await recoverUserActionSignedIdentities(db.runtime, outcomes, 25);
      const successor = await userActionEngineFixture(
        db.runtime,
        'cancel_locked_timeout',
        'raw',
        'successor',
        '2000000600',
      );
      successor.ports.verifyNonceOwnership = (input) =>
        verifyNonceOwnership(db.runtime, input, async (scope) => ({
          status: 'verified',
          evidence: evidence(scope),
        }));
      const witness = await verifyUserAction(successor.ports, successor.input);
      const signed = (await predecessor.requests.inspect(
        'owner',
        predecessor.input.sourceOperationId!,
      ))!.attempts.find((event) => event.eventType === 'signed')!;
      await outcomes.markBroadcastUnknown(signed.transactionHash!, 'CONTROLLED_UNKNOWN');
      await expect(successor.requests.accept(successor.input, witness)).rejects.toThrow(
        'ownership preflight changed',
      );
      expect(successor.sign).not.toHaveBeenCalled();
    });
  },
);
