import { TradeStatus } from '@agroasys/sdk';
import { config } from '../config';
import { FetchTimeoutError, IndexerNetworkError, fetchWithTimeout } from '../utils/fetchWithTimeout';
import { Logger } from '../utils/logger';

export interface IndexerTrade {
    id: string;
    tradeId: string;
    buyer: string;
    supplier: string;
    status: TradeStatus;
    totalAmountLocked: bigint;
    logisticsAmount: bigint;
    platformFeesAmount: bigint;
    supplierFirstTranche: bigint;
    supplierSecondTranche: bigint;
    ricardianHash: string;
    createdAt: Date;
    arrivalTimestamp: Date | null;
}

export interface IndexerEvent {
    id: string;
    tradeId: string;
    eventName: string;
    txHash: string;
    blockNumber: number;
    timestamp: Date;
}

export class IndexerClient {
    private graphqlUrl: string;

    constructor(graphqlUrl: string) {
        this.graphqlUrl = graphqlUrl;
        Logger.info('IndexerClient initialized', { 
            graphqlUrl 
        });
    }


    async getTrade(tradeId: string): Promise<IndexerTrade | null> {
        try {
            const query = `
                query GetTrade($tradeId: String!) {
                    trades(where: { tradeId_eq: $tradeId }, limit: 1) {
                        id
                        tradeId
                        buyer
                        supplier
                        status
                        totalAmountLocked
                        logisticsAmount
                        platformFeesAmount
                        supplierFirstTranche
                        supplierSecondTranche
                        ricardianHash
                        createdAt
                        arrivalTimestamp
                    }
                }
            `;

            const response = await fetchWithTimeout(this.graphqlUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query,
                    variables: { tradeId },
                }),
            }, config.indexerGraphqlRequestTimeoutMs);

            if (!response.ok) {
                throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();

            if (result.errors) {
                Logger.error('GraphQL errors', { errors: result.errors });
                throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
            }

            const trades = result.data?.trades;

            if (!trades || trades.length === 0) {
                Logger.info('Trade not found in indexer (will use RPC)', { tradeId });
                return null;
            }

            const trade = trades[0];
            
            Logger.info('Trade found in indexer', { 
                tradeId, 
                status: trade.status 
            });
            
            return {
                id: trade.id,
                tradeId: trade.tradeId,
                buyer: trade.buyer,
                supplier: trade.supplier,
                status: this.mapIndexerStatus(trade.status, tradeId),
                totalAmountLocked: BigInt(trade.totalAmountLocked),
                logisticsAmount: BigInt(trade.logisticsAmount),
                platformFeesAmount: BigInt(trade.platformFeesAmount),
                supplierFirstTranche: BigInt(trade.supplierFirstTranche),
                supplierSecondTranche: BigInt(trade.supplierSecondTranche),
                ricardianHash: trade.ricardianHash,
                createdAt: new Date(trade.createdAt),
                arrivalTimestamp: trade.arrivalTimestamp ? new Date(trade.arrivalTimestamp) : null,
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            Logger.error('Failed to query indexer', {
                tradeId,
                graphqlUrl: this.graphqlUrl,
                errorType: this.classifyErrorType(error),
                error: errorMessage,
            });
            return null;
        }
    }

    private mapIndexerStatus(status: string, tradeId: string): TradeStatus {
        const statusMap: Record<string, TradeStatus> = {
            'LOCKED': TradeStatus.LOCKED,
            'IN_TRANSIT': TradeStatus.IN_TRANSIT,
            'ARRIVAL_CONFIRMED': TradeStatus.ARRIVAL_CONFIRMED,
            'FROZEN': TradeStatus.FROZEN,
            'CLOSED': TradeStatus.CLOSED,
        };
        
        if (!(status in statusMap)) {
            Logger.error('Unknown trade status from indexer', { 
                tradeId, 
                status,
                knownStatuses: Object.keys(statusMap)
            });
            throw new Error(`Unknown trade status from indexer: ${status} for trade ${tradeId}`);
        }
        
        return statusMap[status];
    }


    async findConfirmationEvent(txHash: string, tradeId: string): Promise<IndexerEvent | null> {
        try {
            const query = `
                query GetTradeEvent($txHash: String!) {
                    tradeEvents(
                        where: { txHash_eq: $txHash }
                        orderBy: timestamp_DESC
                        limit: 1
                    ) {
                        id
                        trade {
                            tradeId
                        }
                        eventName
                        txHash
                        blockNumber
                        timestamp
                    }
                }
            `;

            const response = await fetchWithTimeout(this.graphqlUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query,
                    variables: { txHash },
                }),
            }, config.indexerGraphqlRequestTimeoutMs);

            if (!response.ok) {
                throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();

            if (result.errors) {
                Logger.error('GraphQL errors', { errors: result.errors });
                return null;
            }

            const events = result.data?.tradeEvents;

            if (!events || events.length === 0) {
                Logger.info('Event not yet indexed', { txHash, tradeId });
                return null;
            }

            const event = events[0];
            
            if (event.trade.tradeId !== tradeId) {
                Logger.warn('TX hash found but trade_id mismatch', {
                    txHash,
                    expectedTradeId: tradeId,
                    foundTradeId: event.trade.tradeId
                });
                return null;
            }

            return {
                id: event.id,
                tradeId: event.trade.tradeId,
                eventName: event.eventName,
                txHash: event.txHash,
                blockNumber: event.blockNumber,
                timestamp: new Date(event.timestamp),
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error('Failed to find confirmation event', { 
                txHash, 
                tradeId, 
                graphqlUrl: this.graphqlUrl,
                errorType: this.classifyErrorType(error),
                error: errorMessage,
            });
            return null;
        }
    }

    private classifyErrorType(error: unknown): 'timeout' | 'network' | 'http' | 'graphql' | 'unknown' {
        if (error instanceof FetchTimeoutError) {
            return 'timeout';
        }

        if (error instanceof IndexerNetworkError) {
            return 'network';
        }

        if (error instanceof Error && error.message.startsWith('GraphQL request failed:')) {
            return 'http';
        }

        if (error instanceof Error && error.message.startsWith('GraphQL errors:')) {
            return 'graphql';
        }

        return 'unknown';
    }

    async close(): Promise<void> {
        Logger.info('IndexerClient closed (no-op for HTTP client)');
    }
}
