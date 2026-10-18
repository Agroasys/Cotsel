/** SPDX-License-Identifier: Apache-2.0 */
// Internal engine only. Public custody entry points continue to deny unconditionally.
import {
  getAddress,
  keccak256,
  Transaction,
  type TransactionRequest,
  type TransactionResponse,
  type Wallet,
  type FeeData,
} from 'ethers';
import { buildManagedSignerIntentHash } from '@agroasys/sdk';
import type { ManagedSignerTransactionIntent } from '@agroasys/sdk';
import type { GaslessUserActionExecutionInput } from '../gaslessExecutionTypes';
import type { GaslessNonceReservationStore } from '../gaslessNonceReservationStore';
import type { GaslessTransactionOutcomeRecorder } from '../gaslessTransactionOutcomeStore';
import type { GaslessFinalityVerifier } from '../gaslessChainFinality';
import type { ManagedSignerTransport } from '../managedSignerTransport';
import {
  serializeManagedSignerTransaction,
  validateManagedSignerForBroadcast,
} from '../managedSignerIntentValidation';
import {
  buildManagedUserActionTransaction,
  userActionPolicyContext,
} from '../gaslessManagedSignerTransactions';
import {
  requireSignedTransactionIdentity,
  broadcastPersistedGaslessTransaction,
  persistGaslessTerminalOutcome,
  GaslessTransactionOutcomePendingError,
  GaslessTransactionRevertedError,
} from '../gaslessTransactionLifecycle';
import { assertContractMatchesRuntime } from '../gaslessExecutionValidation';
import { requireGaslessChainId } from '../gaslessRequestNormalization';
import { assertDormantAction, deny, fingerprint } from './validation';
export interface UserActionProvider {
  call(tx: TransactionRequest): Promise<string>;
  estimateGas(tx: TransactionRequest): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getFeeData(): Promise<FeeData>;
  getTransactionCount(address: string, tag: 'pending'): Promise<number>;
  broadcastTransaction(signed: string): Promise<TransactionResponse>;
}
export interface UserActionCustodyPorts {
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  provider: UserActionProvider;
  nonces: GaslessNonceReservationStore;
  outcomes: GaslessTransactionOutcomeRecorder;
  finality: GaslessFinalityVerifier;
  maxGasLimit: bigint;
  maxFeePerGasWei: bigint;
  maxNativeCostWei: bigint;
  minBalanceWei: bigint;
  receiptTimeoutMs: number;
  observeBalance?(balance: bigint): void;
  signer:
    | { mode: 'raw'; wallet: Pick<Wallet, 'getAddress' | 'signTransaction'> }
    | { mode: 'kms' | 'mpc'; transport: ManagedSignerTransport };
}
export interface PreparedUserAction {
  readonly gasEstimate: bigint;
  execute(
    authorizeSigning: () => Promise<void>,
    recordSigned: (
      identity: import('../gaslessTransactionOutcomeStore').GaslessTransactionIdentity,
    ) => Promise<void>,
    recordHash: (type: 'provider_hash' | 'signer_rejected', hash: string) => Promise<void>,
  ): Promise<{ txHash: string; confirmed: boolean }>;
}
/** No DB locks span provider/signer calls. The owner supplies a durable signing fence. */
export async function prepareUserActionCustody(
  ports: UserActionCustodyPorts,
  input: GaslessUserActionExecutionInput,
  applicationRequestId: string,
): Promise<PreparedUserAction> {
  assertDormantAction(input);
  requireGaslessChainId(input.chainId, ports.chainId);
  assertContractMatchesRuntime(input, ports.escrowAddress);
  const signer = ports.signer;
  const address = getAddress(
    await (signer.mode === 'raw'
      ? signer.wallet.getAddress()
      : signer.transport.getSignerAddress()),
  );
  const tx = buildManagedUserActionTransaction(ports, input, address);
  await ports.provider.call(tx);
  const gasLimit = await ports.provider.estimateGas(tx);
  const fees = await ports.provider.getFeeData();
  const effectiveFee = fees.maxFeePerGas ?? fees.gasPrice;
  const balance = await ports.provider.getBalance(address);
  ports.observeBalance?.(balance);
  if (
    gasLimit <= 0n ||
    gasLimit > ports.maxGasLimit ||
    !effectiveFee ||
    effectiveFee <= 0n ||
    effectiveFee > ports.maxFeePerGasWei ||
    gasLimit * effectiveFee > ports.maxNativeCostWei ||
    balance < ports.minBalanceWei ||
    balance < gasLimit * effectiveFee
  )
    deny('User-action relayer gas or balance guard denied');
  const nonce = await ports.provider.getTransactionCount(address, 'pending');
  const transaction = {
    ...tx,
    gasLimit,
    nonce,
    ...(fees.maxFeePerGas !== null
      ? {
          type: 2,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
        }
      : { type: 0, gasPrice: fees.gasPrice! }),
  };
  const serialized = serializeManagedSignerTransaction(transaction);
  const requestId = fingerprint([
    applicationRequestId,
    input.action,
    input.handoffId,
    ports.chainId,
    address.toLowerCase(),
    nonce,
  ]);
  const intent: ManagedSignerTransactionIntent = {
    requestId,
    signerAddress: address,
    ...serialized,
  };
  const intentHash = buildManagedSignerIntentHash(intent);
  return {
    gasEstimate: gasLimit,
    async execute(authorizeSigning, recordSigned, recordHash) {
      // Irreversible request marker commits before the nonce marker and ANY signer call.
      await authorizeSigning();
      const reservation = await ports.nonces.reserve({
        chainId: ports.chainId,
        signerAddress: address,
        transactionNonce: nonce,
        requestId,
        applicationRequestId,
        resourceType: 'settlement_handoff',
        resourceId: input.handoffId,
        operation: input.action,
        intentHash,
      });
      await ports.nonces.beginSigning(reservation);
      let signed: string;
      if (signer.mode === 'raw') {
        signed = await signer.wallet.signTransaction(transaction);
        // Apply the same exact signed-intent validator as managed custody.
        signed = await validateManagedSignerForBroadcast(
          { requestId, intentHash, signerAddress: address, signedTransaction: signed },
          intent,
          { operation: input.action, applicationRequestId, resourceId: input.handoffId },
          async (evidence) => {
            if (evidence.outcome === 'rejected' && evidence.signedTransactionHash)
              await recordHash('signer_rejected', evidence.signedTransactionHash);
          },
        );
      } else {
        const response = await signer.transport.signTransaction({
          custodyMode: signer.mode,
          operation: input.action,
          signerAddress: address,
          requestId,
          intentHash,
          transaction: serialized,
          policyContext: userActionPolicyContext(input),
        });
        signed = await validateManagedSignerForBroadcast(
          response,
          intent,
          { operation: input.action, applicationRequestId, resourceId: input.handoffId },
          async (evidence) => {
            if (evidence.outcome === 'rejected' && evidence.signedTransactionHash)
              await recordHash('signer_rejected', evidence.signedTransactionHash);
          },
        );
      }
      const hash = keccak256(signed);
      await recordSigned(
        requireSignedTransactionIdentity(signed, {
          applicationRequestId,
          resourceType: 'settlement_handoff',
          resourceId: input.handoffId,
          operation: input.action,
          intentHash,
          sourceApiKeyId: input.sourceApiKeyId,
        }),
      );
      await ports.nonces.recordSigned(reservation, hash);
      const context = {
        applicationRequestId,
        resourceType: 'settlement_handoff' as const,
        resourceId: input.handoffId,
        operation: input.action,
        intentHash,
        sourceApiKeyId: input.sourceApiKeyId,
      };
      const response = await broadcastPersistedGaslessTransaction(
        signed,
        context,
        ports.outcomes,
        async (bytes) => {
          const result = await ports.provider.broadcastTransaction(bytes);
          if (result.hash.toLowerCase() !== hash) await recordHash('provider_hash', result.hash);
          return result;
        },
      );
      let receipt;
      try {
        receipt = await response.wait(1, ports.receiptTimeoutMs);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'TRANSACTION_REPLACED'
        ) {
          const observed = new Set<string>();
          for (const name of ['replacement', 'receipt'] as const) {
            const candidate = (error as Record<string, unknown>)[name];
            const candidateHash =
              candidate && typeof candidate === 'object' && 'hash' in candidate
                ? candidate.hash
                : null;
            if (
              typeof candidateHash === 'string' &&
              /^0x[0-9a-f]{64}$/i.test(candidateHash) &&
              candidateHash.toLowerCase() !== hash
            )
              observed.add(candidateHash.toLowerCase());
          }
          for (const candidateHash of observed) await recordHash('provider_hash', candidateHash);
        }
        throw new GaslessTransactionOutcomePendingError(
          hash,
          'confirmation_pending',
          'User-action transaction requires observation',
        );
      }
      if (!receipt)
        throw new GaslessTransactionOutcomePendingError(
          hash,
          'confirmation_pending',
          'User-action transaction requires observation',
        );
      const evidence = await ports.finality.verifyReceipt(ports.chainId, hash, receipt);
      if (!evidence)
        throw new GaslessTransactionOutcomePendingError(
          hash,
          'confirmation_pending',
          'User-action transaction awaits finalized evidence',
        );
      const outcome = {
        blockNumber: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.gasPrice.toString(),
        finalityEvidence: evidence,
      };
      await persistGaslessTerminalOutcome(
        ports.outcomes,
        hash,
        receipt.status === 1 ? 'confirmed' : 'reverted',
        outcome,
      );
      if (receipt.status !== 1)
        throw new GaslessTransactionRevertedError(hash, outcome.blockNumber);
      return { txHash: Transaction.from(signed).hash!, confirmed: true };
    },
  };
}
