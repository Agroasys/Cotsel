import { createHash } from 'node:crypto';
import { getAddress, JsonRpcProvider, type Provider } from 'ethers';
import { ValidationError } from '../utils/errors';

type Witness = {
  id: string;
  provider: Pick<Provider, 'getNetwork' | 'getTransactionReceipt' | 'getBlock' | 'getTransaction'>;
};
export type OracleDispatchFinality = {
  policy: 'oracle_dispatch_nonce_finality_v1';
  signerScope: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  receiptStatus: 0 | 1;
  witnessIds: [string, string];
  verifiedAt: string;
};
export function createOracleDispatchWitnesses(urls: string[]): Witness[] {
  const hosts = new Set<string>();
  const result: Witness[] = [];
  for (const url of urls) {
    const host = new URL(url).hostname.toLowerCase();
    if (hosts.has(host)) continue;
    hosts.add(host);
    result.push({
      id: createHash('sha256').update(url).digest('hex'),
      provider: new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }),
    });
    if (result.length === 2) break;
  }
  return result;
}
/** A nonce witness resolves only the original transaction, never financial success. */
export async function verifyOracleDispatchFinality(
  witnesses: Witness[],
  signerScope: string,
  transactionHash: string,
): Promise<OracleDispatchFinality> {
  const [chainId, address, extra] = signerScope.split(':');
  if (
    !/^[1-9][0-9]*$/.test(chainId ?? '') ||
    extra !== undefined ||
    !address ||
    getAddress(address).toLowerCase() !== address ||
    !/^0x[0-9a-f]{64}$/.test(transactionHash) ||
    witnesses.length !== 2 ||
    witnesses[0].id === witnesses[1].id
  )
    throw new ValidationError('Independent Oracle signer evidence is required');
  let timer: NodeJS.Timeout | undefined;
  try {
    const observations = await Promise.race([
      Promise.all(
        witnesses.map(
          async ({
            provider,
          }): Promise<
            Pick<OracleDispatchFinality, 'blockNumber' | 'blockHash' | 'receiptStatus'>
          > => {
            const [network, receipt, finalized] = await Promise.all([
              provider.getNetwork(),
              provider.getTransactionReceipt(transactionHash),
              provider.getBlock('finalized'),
            ]);
            if (
              network.chainId.toString() !== chainId ||
              !receipt ||
              receipt.hash.toLowerCase() !== transactionHash ||
              receipt.from.toLowerCase() !== address ||
              (receipt.status !== 0 && receipt.status !== 1) ||
              !Number.isSafeInteger(receipt.blockNumber) ||
              receipt.blockNumber < 0 ||
              !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ||
              !finalized ||
              finalized.number < receipt.blockNumber
            )
              throw new ValidationError('Original Oracle dispatch remains unresolved');
            const block = await provider.getBlock(receipt.blockNumber);
            if (
              !block ||
              block.number !== receipt.blockNumber ||
              block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
            )
              throw new ValidationError('Original Oracle dispatch is not canonical');
            return {
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash.toLowerCase(),
              receiptStatus: receipt.status,
            };
          },
        ),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), 10000);
      }),
    ]);
    if (JSON.stringify(observations[0]) !== JSON.stringify(observations[1]))
      throw new ValidationError('Oracle dispatch witnesses disagree');
    return {
      policy: 'oracle_dispatch_nonce_finality_v1',
      signerScope,
      transactionHash,
      ...observations[0],
      witnessIds: [witnesses[0].id, witnesses[1].id],
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new Error('Independent Oracle dispatch witnesses are unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
