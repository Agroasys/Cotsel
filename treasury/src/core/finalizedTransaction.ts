/** SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type Provider,
} from 'ethers';
import type { SettlementLog } from './chainCanonicality';

class TreasuryReceiptEvidenceError extends Error {}

const escrow = new Interface([
  'function treasuryAddress() view returns(address)',
  'function usdcToken() view returns(address)',
]);
export type TreasurySweepWitness = {
  id: string;
  provider: Pick<Provider, 'getNetwork' | 'getBlock' | 'getTransactionReceipt' | 'call'>;
};
export type TreasuryFinalizedEvidence = {
  policyVersion: 'treasury_dual_rpc_finalized_v1';
  chainId: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  rpcWitnesses: string[];
  finalizedHeads: Array<{ number: string; hash: string }>;
  verifiedAt: string;
};
export type TreasurySweepRail = { chainId: number; escrowAddress: string; usdcAddress: string };
export type FinalizedTransactionVerdict =
  | {
      finalized: true;
      finalizedBlockNumber: number;
      blockHash: string;
      escrowAddress: string;
      tokenAddress: string;
      treasuryIdentity: string;
      finalizedEvidence: TreasuryFinalizedEvidence;
      logs: ReadonlyArray<SettlementLog>;
    }
  | { finalized: false; detail: string; unavailable?: true };

/** Independent readers for the existing matcher. No observer or fallback to a single RPC is introduced. */
export function createTreasurySweepWitnesses(urls: string[]): TreasurySweepWitness[] {
  const hosts = new Set<string>();
  const witnesses: TreasurySweepWitness[] = [];
  for (const raw of urls) {
    const url = new URL(raw);
    if (hosts.has(url.hostname)) continue;
    hosts.add(url.hostname);
    witnesses.push({
      id: createHash('sha256').update(raw).digest('hex'),
      provider: new JsonRpcProvider(raw, undefined, { cacheTimeout: -1 }),
    });
    if (witnesses.length === 2) break;
  }
  return witnesses;
}

export class FinalizedTransactionVerifier {
  constructor(
    private readonly deps: {
      witnesses: readonly TreasurySweepWitness[];
      rail: TreasurySweepRail | null;
    },
  ) {}
  async verify(txHash: string, blockNumber: number): Promise<FinalizedTransactionVerdict> {
    const { witnesses, rail } = this.deps;
    if (
      !rail ||
      witnesses.length !== 2 ||
      witnesses.some((w) => !/^[0-9a-f]{64}$/.test(w.id)) ||
      new Set(witnesses.map((w) => w.id)).size !== 2 ||
      !Number.isSafeInteger(rail.chainId) ||
      rail.chainId <= 0
    )
      return {
        finalized: false,
        detail:
          'Settlement runtime is not configured with an approved deployment and independent witnesses',
      };
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0)
      return { finalized: false, detail: 'Invalid treasury claim block identity' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const readings = await Promise.race([
        Promise.all(
          witnesses.map(async ({ provider }) => {
            const [network, head, receipt, block] = await Promise.all([
              provider.getNetwork(),
              provider.getBlock('finalized'),
              provider.getTransactionReceipt(txHash),
              provider.getBlock(blockNumber),
            ]);
            if (network.chainId !== BigInt(rail.chainId))
              throw new TreasuryReceiptEvidenceError(
                'Treasury RPC network differs from its approved rail',
              );
            if (!head?.hash || !/^0x[0-9a-f]{64}$/i.test(head.hash))
              throw new TreasuryReceiptEvidenceError('Settlement RPC reported no finalized head');
            if (blockNumber > head.number)
              throw new TreasuryReceiptEvidenceError(
                `Block ${blockNumber} is above the finalized head ${head.number}`,
              );
            if (!receipt)
              throw new TreasuryReceiptEvidenceError(
                `Transaction ${txHash} has no receipt on the canonical chain`,
              );
            if (receipt.status !== 1)
              throw new TreasuryReceiptEvidenceError(
                `Transaction ${txHash} is not a successful receipt`,
              );
            if (receipt.blockNumber !== blockNumber)
              throw new TreasuryReceiptEvidenceError(
                `Transaction ${txHash} is at block ${receipt.blockNumber} on the canonical chain, not the reported ${blockNumber}`,
              );
            if (
              receipt.hash.toLowerCase() !== txHash.toLowerCase() ||
              receipt.to?.toLowerCase() !== getAddress(rail.escrowAddress).toLowerCase() ||
              !block?.hash ||
              block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
            )
              throw new TreasuryReceiptEvidenceError(
                'Treasury claim receipt does not match its approved escrow and canonical block',
              );
            const [identity, token] = await Promise.all(
              ['treasuryAddress', 'usdcToken'].map((method) =>
                provider.call({
                  to: rail.escrowAddress,
                  data: escrow.encodeFunctionData(method),
                  blockTag: blockNumber,
                }),
              ),
            );
            const treasuryIdentity = getAddress(
              escrow.decodeFunctionResult('treasuryAddress', identity)[0],
            ).toLowerCase();
            const tokenAddress = getAddress(
              escrow.decodeFunctionResult('usdcToken', token)[0],
            ).toLowerCase();
            if (tokenAddress !== getAddress(rail.usdcAddress).toLowerCase())
              throw new TreasuryReceiptEvidenceError(
                'Treasury escrow token differs from the approved settlement token',
              );
            const fingerprint = keccak256(
              toUtf8Bytes(
                JSON.stringify([
                  receipt.blockHash.toLowerCase(),
                  treasuryIdentity,
                  tokenAddress,
                  receipt.logs.map((log) => [
                    log.address.toLowerCase(),
                    log.topics.map((topic) => topic.toLowerCase()),
                    log.data.toLowerCase(),
                    log.index,
                  ]),
                ]),
              ),
            );
            return {
              finalizedBlockNumber: head.number,
              finalizedHeadHash: head.hash.toLowerCase(),
              blockHash: receipt.blockHash.toLowerCase(),
              treasuryIdentity,
              tokenAddress,
              logs: receipt.logs,
              fingerprint,
            };
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Treasury receipt witnesses are unavailable')),
            10_000,
          );
        }),
      ]);
      const first = readings[0],
        second = readings[1];
      if (!first || !second || first.fingerprint !== second.fingerprint)
        throw new TreasuryReceiptEvidenceError('Independent treasury receipt witnesses disagree');
      return {
        finalized: true,
        finalizedBlockNumber: Math.min(first.finalizedBlockNumber, second.finalizedBlockNumber),
        blockHash: first.blockHash,
        escrowAddress: getAddress(rail.escrowAddress).toLowerCase(),
        tokenAddress: first.tokenAddress,
        treasuryIdentity: first.treasuryIdentity,
        finalizedEvidence: {
          policyVersion: 'treasury_dual_rpc_finalized_v1',
          chainId: String(rail.chainId),
          transactionHash: txHash.toLowerCase(),
          blockNumber: String(blockNumber),
          blockHash: first.blockHash,
          rpcWitnesses: witnesses.map((w) => w.id),
          finalizedHeads: readings.map((r) => ({
            number: String(r.finalizedBlockNumber),
            hash: r.finalizedHeadHash,
          })),
          verifiedAt: new Date().toISOString(),
        },
        logs: first.logs,
      };
    } catch (error) {
      return {
        finalized: false,
        detail:
          error instanceof TreasuryReceiptEvidenceError
            ? error.message
            : 'Independent treasury receipt verification is unavailable',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Owning persistence command rechecks this short-lived server result after acquiring its batch lock. */
export function assertFreshTreasuryFinalizedEvidence(
  evidence: TreasuryFinalizedEvidence,
  transactionHash: string,
  blockNumber: string,
): void {
  if (
    !evidence ||
    evidence.policyVersion !== 'treasury_dual_rpc_finalized_v1' ||
    evidence.transactionHash !== transactionHash.toLowerCase() ||
    evidence.blockNumber !== blockNumber ||
    !/^0x[0-9a-f]{64}$/.test(evidence.blockHash) ||
    !/^[1-9][0-9]*$/.test(evidence.chainId) ||
    !Number.isFinite(Date.parse(evidence.verifiedAt)) ||
    Date.parse(evidence.verifiedAt) > Date.now() ||
    Date.now() - Date.parse(evidence.verifiedAt) > 10_000 ||
    !Array.isArray(evidence.rpcWitnesses) ||
    evidence.rpcWitnesses.length !== 2 ||
    new Set(evidence.rpcWitnesses).size !== 2 ||
    evidence.rpcWitnesses.some((id) => !/^[0-9a-f]{64}$/.test(id)) ||
    !Array.isArray(evidence.finalizedHeads) ||
    evidence.finalizedHeads.length !== 2 ||
    evidence.finalizedHeads.some(
      (head) =>
        !/^0x[0-9a-f]{64}$/.test(head.hash) ||
        !/^(0|[1-9][0-9]*)$/.test(head.number) ||
        BigInt(head.number) < BigInt(blockNumber),
    )
  )
    throw new Error(
      'Fresh independent finalized treasury evidence is required to commit sweep accounting',
    );
}
