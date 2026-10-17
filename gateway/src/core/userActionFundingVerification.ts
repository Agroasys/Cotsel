/** SPDX-License-Identifier: Apache-2.0 */
import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type Provider,
} from 'ethers';
import { GatewayError } from '../errors';
import {
  parseSettlementUserActionBinding,
  type SettlementUserActionBinding,
} from './settlementUserActionBinding';

const events = new Interface([
  'event TradeLocked(uint256 indexed tradeId,address indexed buyer,address indexed supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
type Deployment = { chainId: number; escrowAddress: string; usdcAddress: string };
export type UserActionFundingWitness = Pick<
  Provider,
  'getNetwork' | 'getBlock' | 'getTransactionReceipt'
>;
export type UserActionFundingVerifier = (binding: SettlementUserActionBinding) => Promise<void>;
function unavailable(): never {
  throw new GatewayError(
    503,
    'UPSTREAM_UNAVAILABLE',
    'Original user-action funding requires independent finalized verification',
  );
}
/** Read-only: never obtains signer capacity, accepts an action, or creates retrospective approval. */
export function createUserActionFundingVerifier(
  config: Deployment & { rpcUrl: string; rpcFallbackUrls?: string[] },
): UserActionFundingVerifier {
  const hosts = new Set<string>();
  const witnesses: UserActionFundingWitness[] = [];
  for (const url of [config.rpcUrl, ...(config.rpcFallbackUrls ?? [])]) {
    const host = new URL(url).hostname;
    if (hosts.has(host)) continue;
    hosts.add(host);
    witnesses.push(new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
    if (witnesses.length === 2) break;
  }
  return (binding) => verifyUserActionFunding(config, witnesses, binding);
}
export async function verifyUserActionFunding(
  deployment: Deployment,
  witnesses: UserActionFundingWitness[],
  value: SettlementUserActionBinding,
): Promise<void> {
  const binding = parseSettlementUserActionBinding(value, value.ownerServiceId);
  if (
    String(deployment.chainId) !== binding.chainId ||
    getAddress(deployment.escrowAddress).toLowerCase() !== binding.escrowAddress ||
    getAddress(deployment.usdcAddress).toLowerCase() !== binding.tokenAddress ||
    witnesses.length !== 2 ||
    witnesses[0] === witnesses[1]
  )
    return unavailable();
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
            receipt.to?.toLowerCase() !== binding.escrowAddress ||
            receipt.hash.toLowerCase() !== binding.fundingTransactionHash ||
            receipt.blockHash.toLowerCase() !== binding.fundingBlockHash ||
            String(receipt.blockNumber) !== binding.fundingBlockNumber ||
            block?.hash?.toLowerCase() !== binding.fundingBlockHash ||
            !finalized?.hash ||
            finalized.number < receipt.blockNumber
          )
            return unavailable();
          const locks = receipt.logs
            .filter((log) => log.address.toLowerCase() === binding.escrowAddress)
            .flatMap((log) => {
              try {
                const p = events.parseLog(log);
                return p?.name === 'TradeLocked' ? [p] : [];
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
            lock.args.totalAmount.toString() !== binding.totalAmount ||
            lock.args.supplierSecondTranche.toString() !== binding.supplierSecondTranche ||
            BigInt(lock.args.logisticsAmount) +
              BigInt(lock.args.platformFeesAmount) +
              BigInt(lock.args.supplierFirstTranche) +
              BigInt(lock.args.supplierSecondTranche) !==
              BigInt(binding.totalAmount)
          )
            return unavailable();
          const transfers = receipt.logs
            .filter((log) => log.address.toLowerCase() === binding.tokenAddress)
            .flatMap((log) => {
              try {
                const p = events.parseLog(log);
                return p?.name === 'Transfer' &&
                  (p.args.from.toLowerCase() === binding.escrowAddress ||
                    p.args.to.toLowerCase() === binding.escrowAddress)
                  ? [p]
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
            return unavailable();
          return {
            finalized,
            logHash: keccak256(
              toUtf8Bytes(
                JSON.stringify(
                  receipt.logs.map((log) => [
                    log.address.toLowerCase(),
                    log.topics.map((t) => t.toLowerCase()),
                    log.data.toLowerCase(),
                    log.index,
                  ]),
                ),
              ),
            ),
          };
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('funding witness timeout')), 10000);
      }),
    ]);
    if (observations[0].logHash !== observations[1].logHash) return unavailable();
    const commonHeight = Math.min(...observations.map((o) => o.finalized.number));
    clearTimeout(timer);
    const anchors = await Promise.race([
      Promise.all(witnesses.map((provider) => provider.getBlock(commonHeight))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('funding anchor timeout')), 10000);
      }),
    ]);
    if (!anchors[0]?.hash || anchors[0].hash.toLowerCase() !== anchors[1]?.hash?.toLowerCase())
      return unavailable();
  } catch {
    return unavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
