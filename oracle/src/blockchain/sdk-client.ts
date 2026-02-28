import { ethers } from 'ethers';
import { OracleSDK, Trade } from '@agroasys/sdk';
import { Logger } from '../utils/logger';
import { IndexerClient, IndexerTrade } from './indexer-client';

export interface BlockchainResult {
    txHash: string;
    blockNumber: number;
}

export class SDKClient {
    private sdk: OracleSDK;
    private signer: ethers.Wallet;
    private indexer: IndexerClient;

    constructor(
        rpcUrl: string,
        privateKey: string,
        escrowAddress: string,
        usdcAddress: string,
        chainId: number,
        indexer: IndexerClient
    ) {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        this.signer = new ethers.Wallet(privateKey, provider);

        this.sdk = new OracleSDK({
            rpc: rpcUrl,
            chainId,
            escrowAddress,
            usdcAddress,
        });

        this.indexer = indexer;

        Logger.info('SDKClient initialized', {
            oracleAddress: this.signer.address,
            escrowAddress,
            chainId,
        });
    }

    async getTrade(tradeId: string): Promise<Trade> {
        Logger.info('Querying on-chain trade state', { tradeId });
        const trade = await this.sdk.getTrade(tradeId);

        if (
            !trade ||
            trade.tradeId === '0' ||
            trade.buyer === '0x0000000000000000000000000000000000000000'
        ) {
            const { ValidationError } = await import('../utils/errors');
            throw new ValidationError(`Trade ${tradeId} does not exist on-chain`);
        }

        return trade;
    }

    private mapIndexerTradeToSDK(indexerTrade: IndexerTrade): Trade {
        return {
            tradeId: indexerTrade.tradeId,
            buyer: indexerTrade.buyer,
            supplier: indexerTrade.supplier,
            status: indexerTrade.status,
            totalAmountLocked: indexerTrade.totalAmountLocked,
            logisticsAmount: indexerTrade.logisticsAmount,
            platformFeesAmount: indexerTrade.platformFeesAmount,
            supplierFirstTranche: indexerTrade.supplierFirstTranche,
            supplierSecondTranche: indexerTrade.supplierSecondTranche,
            ricardianHash: indexerTrade.ricardianHash,
            createdAt: indexerTrade.createdAt,
            arrivalTimestamp: indexerTrade.arrivalTimestamp ?? undefined,
        };
    }

    async releaseFundsStage1(tradeId: string): Promise<BlockchainResult> {
        Logger.info('Executing releaseFundsStage1', { tradeId });
        
        const result = await this.sdk.releaseFundsStage1(tradeId, this.signer);
        
        Logger.info('Stage 1 release successful', { 
            tradeId, 
            txHash: result.txHash 
        });

        return {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
        };
    }

    async confirmArrival(tradeId: string): Promise<BlockchainResult> {
        Logger.info('Executing confirmArrival', { tradeId });
        
        const result = await this.sdk.confirmArrival(tradeId, this.signer);
        
        Logger.info('Arrival confirmation successful', { 
            tradeId, 
            txHash: result.txHash 
        });

        return {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
        };
    }

    async finalizeTrade(tradeId: string): Promise<BlockchainResult> {
        Logger.info('Executing finalizeTrade', { tradeId });
        
        const result = await this.sdk.finalizeAfterDisputeWindow(tradeId, this.signer);
        
        Logger.info('Trade finalization successful', { 
            tradeId, 
            txHash: result.txHash 
        });

        return {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
        };
    }
}
