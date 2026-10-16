import { selectObservedSettlementRail } from '../config/retainedSettlementRails';
/** SPDX-License-Identifier: Apache-2.0 */
import { Router, type Response, type NextFunction } from 'express';
import { JsonRpcProvider } from 'ethers';
import { createGaslessFinalityVerifier } from '../core/gaslessChainFinality';
import { GatewayError } from '../errors';
import { successResponse } from '../responses';
import type { SettlementRouterOptions } from './settlement';

/** Mounted after the parent's mandatory service authentication. Observes without issuing money. */
export function createSettlementObservationRouter(
  options: Pick<SettlementRouterOptions, 'config' | 'gaslessTransactionOutcomes'>,
): Router {
  const router = Router();
  const finality = createGaslessFinalityVerifier(options.config);
  const providers = new Map<string, JsonRpcProvider>();
  router.get('/settlement/transactions/:transactionHash/finality', (req, res, next) => {
    void (async () => {
      const transactionHash = String(req.params.transactionHash);
      if (!/^0x[0-9a-f]{64}$/i.test(transactionHash))
        throw new GatewayError(400, 'VALIDATION_ERROR', 'A canonical transaction hash is required');
      if (Object.keys(req.query).some((key) => !['chainId', 'escrowAddress'].includes(key)))
        throw new GatewayError(400, 'VALIDATION_ERROR', 'Unsupported observation query');
      const requestedChain = req.query.chainId;
      const requestedEscrow = req.query.escrowAddress;
      if (
        (requestedChain !== undefined || requestedEscrow !== undefined) &&
        (typeof requestedChain !== 'string' ||
          !/^[1-9][0-9]{0,15}$/.test(requestedChain) ||
          !Number.isSafeInteger(Number(requestedChain)) ||
          typeof requestedEscrow !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(requestedEscrow))
      )
        throw new GatewayError(
          400,
          'VALIDATION_ERROR',
          'Chain and escrow observation identity must be provided together',
        );
      const chainId =
        typeof requestedChain === 'string' ? Number(requestedChain) : options.config.chainId;
      const escrowAddress =
        typeof requestedEscrow === 'string' ? requestedEscrow : options.config.escrowAddress;
      const rail = selectObservedSettlementRail(options.config, chainId, escrowAddress);
      if (!rail || rail.escrowAddress.toLowerCase() !== escrowAddress.toLowerCase())
        throw new GatewayError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'Historical deployment observation is not approved',
        );
      let evidenceProvider = providers.get(rail.rpcUrl);
      if (!evidenceProvider) {
        evidenceProvider = new JsonRpcProvider(rail.rpcUrl, undefined, { cacheTimeout: -1 });
        providers.set(rail.rpcUrl, evidenceProvider);
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const receipt = await Promise.race([
          evidenceProvider.getTransactionReceipt(transactionHash),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new GatewayError(
                    503,
                    'UPSTREAM_UNAVAILABLE',
                    'Finalized settlement evidence is pending',
                  ),
                ),
              10_000,
            );
          }),
        ]);
        const evidence =
          receipt &&
          receipt.status === 1 &&
          receipt.to?.toLowerCase() === rail.escrowAddress.toLowerCase()
            ? await finality.verifyReceipt(rail.chainId, transactionHash, receipt)
            : null;
        if (!evidence?.projectionCoverage)
          throw new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'Finalized settlement coverage is pending',
          );
        res.json(successResponse(evidence));
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().catch((error: unknown) =>
      next(
        error instanceof GatewayError
          ? error
          : new GatewayError(
              503,
              'UPSTREAM_UNAVAILABLE',
              'Finalized settlement evidence is unavailable',
            ),
      ),
    );
  });

  router.get('/wallet/usdc/gasless-transfers/:transferId/outcomes', (req, res, next) =>
    handleRequest(
      async () => {
        const sourceApiKeyId = req.serviceAuth?.apiKeyId ?? null;
        const transferId = requireString(req.params.transferId, 'transferId');
        if (!sourceApiKeyId || !/^[A-Za-z0-9_-]{1,128}$/.test(transferId))
          throw new GatewayError(
            400,
            'VALIDATION_ERROR',
            'A valid service-bound transfer identity is required.',
          );
        if (!options.gaslessTransactionOutcomes)
          throw new GatewayError(
            503,
            'UPSTREAM_UNAVAILABLE',
            'Retained wallet execution observation is unavailable.',
          );
        return {
          platformTransferId: transferId,
          outcomes: await options.gaslessTransactionOutcomes.listWalletTransferOutcomes(
            sourceApiKeyId,
            transferId,
          ),
        };
      },
      res,
      next,
      200,
    ),
  );

  return router;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new GatewayError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string`);
  return value.trim();
}
async function handleRequest(
  handler: () => Promise<unknown>,
  res: Response,
  next: NextFunction,
  status = 200,
): Promise<void> {
  try {
    res.status(status).json(successResponse(await handler()));
  } catch (error) {
    next(error);
  }
}
