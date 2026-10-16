import { Interface, type Provider } from 'ethers';
import { parseSettlementFundedBinding, type SettlementFundedBinding } from '@agroasys/sdk';
import { verifyOracleDispatchFinality, type OracleDispatchFinality } from './dispatch-finality';
import { ValidationError } from '../utils/errors';
const abi = new Interface([
  'function releaseFundsStage1(uint256)',
  'function confirmInspectionAvailable(uint256,uint256)',
  'function finalizeAfterDisputeWindow(uint256)',
  'event FundsReleasedStage1(uint256 indexed tradeId,address indexed supplier,uint256 supplierFirstTranche,address indexed treasury,uint256 logisticsAmount)',
  'event FinalTrancheReleased(uint256 indexed tradeId,address indexed supplier,uint256 supplierSecondTranche)',
  'event InspectionAvailable(uint256 indexed tradeId,uint256 inspectionAvailableAt,uint256 inspectionWindowSeconds,uint256 noticeDeadline)',
  'event SupplierPayoutTransferred(uint256 indexed tradeId,address indexed supplier,uint256 amount,uint8 claimType,address indexed triggeredBy)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
type Witness = {
  id: string;
  provider: Pick<Provider, 'getNetwork' | 'getTransactionReceipt' | 'getBlock' | 'getTransaction'>;
};
export async function verifyOracleProgressionReceipt(
  witnesses: Witness[],
  scope: string,
  hash: string,
  value: SettlementFundedBinding,
): Promise<OracleDispatchFinality> {
  const binding = parseSettlementFundedBinding(value);
  const evidence = await verifyOracleDispatchFinality(witnesses, scope, hash);
  if (evidence.receiptStatus !== 1 || scope.split(':')[0] !== binding.chainId)
    throw new ValidationError('Original Oracle transaction did not complete successfully');
  const first = binding.phase === 'initial_release_after_custody_and_documents';
  const inspection = binding.phase.startsWith('inspection_available_');
  const final = binding.phase === 'final_release_after_notice_deadline';
  if (!first && !inspection && !final)
    throw new ValidationError('Unsupported Oracle progression receipt');
  const window = binding.phase === 'inspection_available_packaged_local' ? 48 * 3600 : 72 * 3600;
  const data = abi.encodeFunctionData(
    first
      ? 'releaseFundsStage1'
      : inspection
        ? 'confirmInspectionAvailable'
        : 'finalizeAfterDisputeWindow',
    inspection ? [binding.tradeId, window] : [binding.tradeId],
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const observations = await Promise.race([
      Promise.all(
        witnesses.map(async ({ provider }) => {
          const [tx, receipt] = await Promise.all([
            provider.getTransaction(hash),
            provider.getTransactionReceipt(hash),
          ]);
          if (
            !tx ||
            tx.hash.toLowerCase() !== hash ||
            tx.from.toLowerCase() !== scope.split(':')[1] ||
            tx.chainId.toString() !== binding.chainId ||
            tx.to?.toLowerCase() !== binding.escrowAddress ||
            tx.data.toLowerCase() !== data.toLowerCase() ||
            tx.value !== 0n ||
            !receipt ||
            receipt.status !== 1 ||
            receipt.blockHash.toLowerCase() !== evidence.blockHash ||
            receipt.blockNumber !== evidence.blockNumber ||
            receipt.to?.toLowerCase() !== binding.escrowAddress
          )
            throw new ValidationError(
              'Oracle receipt differs from the original funded instruction',
            );
          const parsed = receipt.logs.flatMap((log) => {
            try {
              const event = abi.parseLog(log);
              return event ? [{ address: log.address.toLowerCase(), event }] : [];
            } catch {
              return [];
            }
          });
          const semanticName = first
            ? 'FundsReleasedStage1'
            : inspection
              ? 'InspectionAvailable'
              : 'FinalTrancheReleased';
          const semantic = parsed.filter(
            (row) => row.address === binding.escrowAddress && row.event.name === semanticName,
          );
          const event = semantic[0]?.event;
          if (semantic.length !== 1 || !event || event.args.tradeId.toString() !== binding.tradeId)
            throw new ValidationError('Oracle semantic event differs from the original trade');
          if (inspection) {
            if (
              event.args.inspectionWindowSeconds !== BigInt(window) ||
              event.args.noticeDeadline !== event.args.inspectionAvailableAt + BigInt(window)
            )
              throw new ValidationError(
                'Oracle inspection window differs from the approved instruction',
              );
          } else {
            if (
              event.args.supplier.toLowerCase() !== binding.supplierAddress ||
              (first
                ? event.args.supplierFirstTranche
                : event.args.supplierSecondTranche
              ).toString() !== binding.supplierPayoutAmount ||
              (first && event.args.logisticsAmount.toString() !== binding.logisticsAmount)
            )
              throw new ValidationError(
                'Oracle payout recipient or amount differs from original funding',
              );
          }
          const transfers = parsed.filter(
            (row) =>
              row.address === binding.tokenAddress &&
              row.event.name === 'Transfer' &&
              (row.event.args.from.toLowerCase() === binding.escrowAddress ||
                row.event.args.to.toLowerCase() === binding.escrowAddress),
          );
          const payouts = parsed.filter(
            (row) =>
              row.address === binding.escrowAddress &&
              row.event.name === 'SupplierPayoutTransferred',
          );
          const amount = BigInt(binding.supplierPayoutAmount);
          if (
            transfers.length !== (amount > 0n ? 1 : 0) ||
            payouts.length !== (amount > 0n ? 1 : 0)
          )
            throw new ValidationError('Oracle payout movement is missing or contradictory');
          if (amount > 0n) {
            const transfer = transfers[0].event.args;
            const payout = payouts[0].event.args;
            if (
              transfer.from.toLowerCase() !== binding.escrowAddress ||
              transfer.to.toLowerCase() !== binding.supplierAddress ||
              transfer.value !== amount ||
              payout.tradeId.toString() !== binding.tradeId ||
              payout.supplier.toLowerCase() !== binding.supplierAddress ||
              payout.amount !== amount ||
              payout.claimType !== BigInt(first ? 0 : 3)
            )
              throw new ValidationError(
                'Oracle token movement differs from original funded supplier',
              );
          }
          return JSON.stringify(
            receipt.logs.map((log) => [
              log.address.toLowerCase(),
              log.topics.map((t) => t.toLowerCase()),
              log.data.toLowerCase(),
              log.index,
            ]),
          );
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), 10000);
      }),
    ]);
    if (observations[0] !== observations[1])
      throw new ValidationError('Oracle progression receipt witnesses disagree');
    return evidence;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new Error('Independent Oracle progression evidence is unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
