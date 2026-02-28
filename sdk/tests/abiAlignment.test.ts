/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AgroasysEscrow__factory } from '../src/types/typechain-types/factories/src/AgroasysEscrow__factory';

describe('Escrow ABI alignment', () => {
    const abi = AgroasysEscrow__factory.abi as readonly any[];

    test('uses unpause proposal flow and not direct unpause()', () => {
        const fnNames = abi.filter((item) => item.type === 'function').map((item) => item.name);

        expect(fnNames).toContain('proposeUnpause');
        expect(fnNames).toContain('approveUnpause');
        expect(fnNames).toContain('cancelUnpauseProposal');
        expect(fnNames).not.toContain('unpause');
    });

    test('OracleUpdateProposed includes emergencyFastTrack flag', () => {
        const event = abi.find(
            (item) => item.type === 'event' && item.name === 'OracleUpdateProposed'
        );

        expect(event).toBeDefined();
        expect(event.inputs.map((input: any) => input.type)).toEqual([
            'uint256',
            'address',
            'address',
            'uint256',
            'bool',
        ]);
    });

    test('contains treasury sweep and payout receiver governance methods', () => {
        const fnNames = abi.filter((item) => item.type === 'function').map((item) => item.name);

        expect(fnNames).toContain('claimTreasury');
        expect(fnNames).toContain('treasuryPayoutAddress');
        expect(fnNames).toContain('proposeTreasuryPayoutAddressUpdate');
        expect(fnNames).toContain('approveTreasuryPayoutAddressUpdate');
        expect(fnNames).toContain('executeTreasuryPayoutAddressUpdate');
        expect(fnNames).toContain('cancelExpiredTreasuryPayoutAddressUpdateProposal');
    });

    test('TreasuryClaimed event has deterministic reconciliation fields', () => {
        const event = abi.find(
            (item) => item.type === 'event' && item.name === 'TreasuryClaimed'
        );

        expect(event).toBeDefined();
        expect(event.inputs.map((input: any) => input.type)).toEqual([
            'address',
            'address',
            'uint256',
            'address',
        ]);
    });
});
