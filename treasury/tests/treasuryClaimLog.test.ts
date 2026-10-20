import { Interface } from 'ethers';
import { AgroasysEscrow__factory } from '@agroasys/sdk';
import { verifyTreasuryClaimLog } from '../src/core/treasuryClaimLog';
const emitter = `0x${'1'.repeat(40)}`,
  tokenAddress = `0x${'2'.repeat(40)}`,
  treasuryIdentity = `0x${'3'.repeat(40)}`,
  payoutReceiver = `0x${'4'.repeat(40)}`,
  other = `0x${'5'.repeat(40)}`;
const token = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const escrow = AgroasysEscrow__factory.createInterface();
const claim = {
  address: emitter,
  index: 1,
  ...escrow.encodeEventLog('TreasuryClaimed', [treasuryIdentity, payoutReceiver, 1000000n, other]),
};
const transfer = (
  from = emitter,
  to = payoutReceiver,
  amount = 1000000n,
  address = tokenAddress,
) => ({
  address,
  index: 0,
  ...token.encodeEventLog(token.getEvent('Transfer')!, [from, to, amount]),
});
const verify = (logs: (typeof claim)[], identity = treasuryIdentity) =>
  verifyTreasuryClaimLog({
    logs,
    emitter,
    tokenAddress,
    treasuryIdentity: identity,
    expected: { treasuryIdentity, payoutReceiver, amountRaw: '1000000', triggeredBy: other },
  });
describe('governed treasury sweep semantic and token evidence', () => {
  it('requires exact claim and token movement to the approved receiver', () =>
    expect(verify([claim, transfer()])).toMatchObject({ matched: true }));
  it.each([
    [claim],
    [claim, transfer(emitter, other)],
    [claim, transfer(other, payoutReceiver)],
    [claim, transfer(emitter, payoutReceiver, 999999n)],
    [claim, transfer(emitter, payoutReceiver, 1000000n, other)],
    [claim, transfer(), transfer()],
  ])('rejects missing, duplicated and contradictory actual movements %#', (...logs) =>
    expect(verify(logs)).toMatchObject({ matched: false }),
  );
  it('distinguishes the original accounting treasury from the governed payout receiver', () => {
    expect(verify([claim, transfer()], payoutReceiver)).toMatchObject({ matched: false });
    expect(verify([claim, transfer()])).toMatchObject({ matched: true });
  });
});
