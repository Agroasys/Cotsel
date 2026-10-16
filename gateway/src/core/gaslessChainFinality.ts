import {
  selectObservedSettlementRail,
  type RetainedSettlementRail,
} from '../config/retainedSettlementRails';
/** SPDX-License-Identifier: Apache-2.0 */
import {
  verifySettlementProjectionCoverage,
  type ProjectionCoverageConfig,
  type SettlementProjectionCoverage,
} from './settlementProjectionCoverage';
import { JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import type { TransactionReceipt } from 'ethers';

export interface GaslessFinalityEvidence {
  policyVersion: 'gasless_dual_rpc_finalized_v1';
  chainId: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  finalizedBlockNumber: string;
  finalizedBlockHash: string;
  rpcWitnesses: string[];
  projectionCoverage?: SettlementProjectionCoverage;
}
export interface GaslessFinalityVerifier {
  verifyReceipt(
    chainId: number,
    transactionHash: string,
    receipt: TransactionReceipt,
  ): Promise<GaslessFinalityEvidence | null>;
  revalidateBlock(
    chainId: number,
    blockNumber: string,
    blockHash: string,
  ): Promise<'canonical' | 'orphaned' | 'unavailable'>;
}

/** Retains the existing observer and coverage services for each approved historical deployment. */
export function createGaslessFinalityVerifier(
  config: ProjectionCoverageConfig & {
    rpcUrl: string;
    rpcFallbackUrls?: string[];
    retainedSettlementRails?: RetainedSettlementRail[];
  },
): GaslessFinalityVerifier {
  const active = { ...config, rpcFallbackUrls: config.rpcFallbackUrls ?? [] };
  const verifiers = new Map<string, GaslessFinalityVerifier>();
  const verifier = (rail: typeof active | RetainedSettlementRail) => {
    const key = `${rail.chainId}:${rail.escrowAddress.toLowerCase()}`;
    let value = verifiers.get(key);
    if (!value) {
      value = createSingleRailFinalityVerifier(rail);
      verifiers.set(key, value);
    }
    return value;
  };
  return {
    verifyReceipt(chainId, hash, receipt) {
      const rail = receipt.to ? selectObservedSettlementRail(active, chainId, receipt.to) : null;
      return rail ? verifier(rail).verifyReceipt(chainId, hash, receipt) : Promise.resolve(null);
    },
    revalidateBlock(chainId, height, hash) {
      const rail = [active, ...(config.retainedSettlementRails ?? [])].find(
        (value) => value.chainId === chainId,
      );
      return rail
        ? verifier(rail).revalidateBlock(chainId, height, hash)
        : Promise.resolve('unavailable');
    },
  };
}

/** No confirmation-count or single-provider fallback. Configuration independence requires operator evidence. */
function createSingleRailFinalityVerifier(
  config: ProjectionCoverageConfig & {
    rpcUrl: string;
    rpcFallbackUrls?: string[];
    chainId: number;
  },
): GaslessFinalityVerifier {
  const urls: string[] = [];
  const hosts = new Set<string>();
  for (const raw of [config.rpcUrl, ...(config.rpcFallbackUrls ?? [])]) {
    const parsed = new URL(raw);
    if (!hosts.has(parsed.hostname)) {
      hosts.add(parsed.hostname);
      urls.push(raw);
    }
    if (urls.length === 2) break;
  }
  const providers = urls.map((url) => new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Chain finality read unavailable')), 10000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function networksMatch(chainId: number): Promise<boolean> {
    if (chainId !== config.chainId || providers.length !== 2) return false;
    return (await bounded(Promise.all(providers.map((provider) => provider.getNetwork())))).every(
      (network) => network.chainId === BigInt(chainId),
    );
  }
  const logsHash = (receipt: TransactionReceipt) =>
    keccak256(
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
  return {
    async verifyReceipt(chainId, transactionHash, observed) {
      if (
        (observed.status !== 0 && observed.status !== 1) ||
        !(await networksMatch(chainId)) ||
        !/^0x[0-9a-f]{64}$/i.test(observed.blockHash)
      )
        return null;
      const witnesses = await bounded(
        Promise.all(
          providers.map(async (provider) => {
            const [receipt, finalized, canonical] = await Promise.all([
              provider.getTransactionReceipt(transactionHash),
              provider.getBlock('finalized'),
              provider.getBlock(observed.blockNumber),
            ]);
            if (
              !receipt ||
              !finalized?.hash ||
              !canonical?.hash ||
              receipt.hash.toLowerCase() !== transactionHash.toLowerCase() ||
              receipt.blockHash.toLowerCase() !== observed.blockHash.toLowerCase() ||
              canonical.hash.toLowerCase() !== observed.blockHash.toLowerCase() ||
              receipt.blockNumber !== observed.blockNumber ||
              receipt.status !== observed.status ||
              receipt.gasUsed !== observed.gasUsed ||
              receipt.gasPrice !== observed.gasPrice ||
              receipt.to?.toLowerCase() !== observed.to?.toLowerCase() ||
              receipt.from.toLowerCase() !== observed.from.toLowerCase() ||
              finalized.number < observed.blockNumber ||
              logsHash(receipt) !== logsHash(observed)
            )
              return null;
            return finalized;
          }),
        ),
      );
      const [first, second] = witnesses;
      if (!first || !second) return null;
      const commonNumber = Math.min(first.number, second.number);
      const [blockA, blockB] = await bounded(
        Promise.all(providers.map((provider) => provider.getBlock(commonNumber))),
      );
      if (!blockA?.hash || blockA.hash.toLowerCase() !== blockB?.hash?.toLowerCase()) return null;
      let projectionCoverage: SettlementProjectionCoverage | null = null;
      if (observed.status === 1) {
        if (observed.to?.toLowerCase() === config.escrowAddress.toLowerCase()) {
          projectionCoverage = await verifySettlementProjectionCoverage(
            config,
            observed,
            commonNumber,
            async (height, expectedHash) => {
              if (BigInt(height) > BigInt(Number.MAX_SAFE_INTEGER)) return false;
              const blocks = await bounded(
                Promise.all(providers.map((provider) => provider.getBlock(Number(height)))),
              );
              return blocks.every((block) => block?.hash?.toLowerCase() === expectedHash);
            },
          );
          if (!projectionCoverage) return null;
        } else if (observed.to?.toLowerCase() !== config.usdcAddress.toLowerCase()) return null;
      }
      return {
        ...(projectionCoverage ? { projectionCoverage } : {}),
        policyVersion: 'gasless_dual_rpc_finalized_v1',
        chainId: String(chainId),
        transactionHash: transactionHash.toLowerCase(),
        blockNumber: String(observed.blockNumber),
        blockHash: observed.blockHash.toLowerCase(),
        finalizedBlockNumber: String(commonNumber),
        finalizedBlockHash: blockA.hash.toLowerCase(),
        rpcWitnesses: urls.map((url) => keccak256(toUtf8Bytes(url))),
      };
    },
    async revalidateBlock(chainId, blockNumber, blockHash) {
      if (!(await networksMatch(chainId))) return 'unavailable';
      const results = await bounded(
        Promise.all(
          providers.map(async (provider) => {
            const [finalized, block] = await Promise.all([
              provider.getBlock('finalized'),
              provider.getBlock(Number(blockNumber)),
            ]);
            if (!finalized || BigInt(finalized.number) < BigInt(blockNumber)) return undefined;
            return block?.hash?.toLowerCase() ?? null;
          }),
        ),
      );
      const [first, second] = results;
      if (first === undefined || second === undefined || first !== second) return 'unavailable';
      return first === blockHash.toLowerCase() ? 'canonical' : 'orphaned';
    },
  };
}
