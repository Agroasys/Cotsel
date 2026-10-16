import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type Provider,
} from 'ethers';
import { parseSettlementFundedBinding, type SettlementFundedBinding } from '@agroasys/sdk';
import { ValidationError } from '../utils/errors';

const events = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export type FundedBindingDeployment = {
  chainId: number;
  escrowAddress: string;
  tokenAddress: string;
};
export type FundedBindingWitness = Pick<
  Provider,
  'getNetwork' | 'getBlock' | 'getTransactionReceipt'
>;
/** Read-only guard on the retained Oracle execution boundary; no observer or retry service is introduced. */
export function createFundedSettlementVerifier(
  deployment: FundedBindingDeployment,
  rpcUrls: string[],
) {
  const hosts = new Set<string>();
  const witnesses: FundedBindingWitness[] = [];
  for (const url of rpcUrls) {
    const host = new URL(url).hostname;
    if (hosts.has(host)) continue;
    hosts.add(host);
    witnesses.push(new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
    if (witnesses.length === 2) break;
  }
  return (binding: SettlementFundedBinding) =>
    verifyFundedSettlementBinding(deployment, witnesses, binding);
}
export async function verifyFundedSettlementBinding(
  deployment: FundedBindingDeployment,
  witnesses: FundedBindingWitness[],
  value: SettlementFundedBinding,
): Promise<void> {
  const binding = parseSettlementFundedBinding(value);
  if (
    String(deployment.chainId) !== binding.chainId ||
    getAddress(deployment.escrowAddress).toLowerCase() !== binding.escrowAddress ||
    getAddress(deployment.tokenAddress).toLowerCase() !== binding.tokenAddress ||
    witnesses.length !== 2
  )
    throw new ValidationError(
      'The funded trade does not belong to this independently witnessed Oracle deployment',
    );
  let timer: NodeJS.Timeout | undefined;
  try {
    const observations = await Promise.race([
      Promise.all(
        witnesses.map(async (provider) => {
          const [network, receipt, block, finalized] = await Promise.all([
            provider.getNetwork(),
            provider.getTransactionReceipt(binding.fundingTransactionHash),
            provider.getBlock(BigInt(binding.fundingBlockNumber)),
            provider.getBlock('finalized'),
          ]);
          if (
            network.chainId.toString() !== binding.chainId ||
            !receipt ||
            receipt.status !== 1 ||
            !receipt.to ||
            receipt.to.toLowerCase() !== binding.escrowAddress ||
            receipt.blockHash.toLowerCase() !== binding.fundingBlockHash ||
            String(receipt.blockNumber) !== binding.fundingBlockNumber ||
            receipt.hash.toLowerCase() !== binding.fundingTransactionHash ||
            !block ||
            block.hash?.toLowerCase() !== binding.fundingBlockHash ||
            !finalized ||
            finalized.number < receipt.blockNumber
          )
            throw new ValidationError(
              'Original funding is not independently finalized and canonical',
            );
          const locks = receipt.logs
            .filter((log) => log.address.toLowerCase() === binding.escrowAddress)
            .flatMap((log) => {
              try {
                const parsed = events.parseLog(log);
                return parsed?.name === 'TradeLocked' ? [parsed] : [];
              } catch {
                return [];
              }
            });
          const lock = locks[0];
          if (
            locks.length !== 1 ||
            !lock ||
            lock.args.tradeId.toString() !== binding.tradeId ||
            lock.args.buyer.toLowerCase() !== binding.buyerAddress ||
            lock.args.supplier.toLowerCase() !== binding.supplierAddress ||
            lock.args.ricardianHash.toLowerCase() !== binding.ricardianHash ||
            [
              'totalAmount',
              'logisticsAmount',
              'platformFeesAmount',
              'supplierFirstTranche',
              'supplierSecondTranche',
            ].some(
              (key) => lock.args[key].toString() !== binding[key as keyof SettlementFundedBinding],
            )
          )
            throw new ValidationError(
              'Original funding event differs from the immutable trade binding',
            );
          const transfers = receipt.logs
            .filter((log) => log.address.toLowerCase() === binding.tokenAddress)
            .flatMap((log) => {
              try {
                const parsed = events.parseLog(log);
                return parsed?.name === 'Transfer' &&
                  (parsed.args.from.toLowerCase() === binding.escrowAddress ||
                    parsed.args.to.toLowerCase() === binding.escrowAddress)
                  ? [parsed]
                  : [];
              } catch {
                return [];
              }
            });
          const transfer = transfers[0];
          if (
            transfers.length !== 1 ||
            !transfer ||
            transfer.args.from.toLowerCase() !== binding.buyerAddress ||
            transfer.args.to.toLowerCase() !== binding.escrowAddress ||
            transfer.args.value.toString() !== binding.totalAmount
          )
            throw new ValidationError(
              'Original funding token movement differs from its buyer and amount',
            );
          return keccak256(
            toUtf8Bytes(
              JSON.stringify(
                receipt.logs.map((log) => [
                  log.address.toLowerCase(),
                  log.topics.map((topic) => topic.toLowerCase()),
                  log.data.toLowerCase(),
                  log.index,
                ]),
              ),
            ),
          );
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Original funding witnesses are unavailable')),
          10_000,
        );
      }),
    ]);
    if (observations[0] !== observations[1])
      throw new ValidationError('Original funding witnesses disagree');
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new Error('Independent original funding witness evidence is unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
