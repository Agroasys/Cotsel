/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers, JsonRpcProvider } from 'ethers';
import { Config } from './config';
import { ContractError } from './types/errors';
import { AgroasysEscrow__factory } from './types/typechain-types/factories/src/AgroasysEscrow__factory';
import type { AgroasysEscrow } from './types/typechain-types/src/AgroasysEscrow';

export class Client {
    protected provider: JsonRpcProvider;
    protected contract: AgroasysEscrow;
    
    constructor(protected config: Config) {
        this.provider = new ethers.JsonRpcProvider(config.rpc);
        this.contract = AgroasysEscrow__factory.connect(
            config.escrowAddress,
            this.provider
        );
    }
    
    async getBuyerNonce(buyerAddress: string): Promise<bigint> {
        try {
            return await this.contract.getBuyerNonce(buyerAddress);
        } catch (error: any) {
            throw new ContractError(
                `Failed to get buyer nonce: ${error.message}`,
                { buyerAddress, error: error.message }
            );
        }
    }
    
    async getTreasuryAddress(): Promise<string> {
        try {
            return await this.contract.treasuryAddress();
        } catch (error: any) {
            throw new ContractError(
                `Failed to get treasury address: ${error.message}`,
                { error: error.message }
            );
        }
    }

    async getTreasuryPayoutAddress(): Promise<string> {
        try {
            return await this.contract.treasuryPayoutAddress();
        } catch (error: any) {
            throw new ContractError(
                `Failed to get treasury payout address: ${error.message}`,
                { error: error.message }
            );
        }
    }
    
    async getOracleAddress(): Promise<string> {
        try {
            return await this.contract.oracleAddress();
        } catch (error: any) {
            throw new ContractError(
                `Failed to get oracle address: ${error.message}`,
                { error: error.message }
            );
        }
    }
    
    async isAdmin(address: string): Promise<boolean> {
        try {
            return await this.contract.isAdmin(address);
        } catch (error: any) {
            throw new ContractError(
                `Failed to check admin status: ${error.message}`,
                { address, error: error.message }
            );
        }
    }

    async isPaused(): Promise<boolean> {
        try {
            return await this.contract.paused();
        } catch (error: any) {
            throw new ContractError(
                `Failed to check paused state: ${error.message}`,
                { error: error.message }
            );
        }
    }

    async isClaimsPaused(): Promise<boolean> {
        try {
            return await this.contract.claimsPaused();
        } catch (error: any) {
            throw new ContractError(
                `Failed to check claimsPaused state: ${error.message}`,
                { error: error.message }
            );
        }
    }

    async getClaimableUsdc(address: string): Promise<bigint> {
        try {
            return await this.contract.claimableUsdc(address);
        } catch (error: any) {
            throw new ContractError(
                `Failed to get claimable USDC: ${error.message}`,
                { address, error: error.message }
            );
        }
    }

    async getTotalClaimableUsdc(): Promise<bigint> {
        try {
            return await this.contract.totalClaimableUsdc();
        } catch (error: any) {
            throw new ContractError(
                `Failed to get total claimable USDC: ${error.message}`,
                { error: error.message }
            );
        }
    }

    async claim(signer: ethers.Signer): Promise<{ txHash: string; blockNumber: number }> {
        try {
            const contractWithSigner = this.contract.connect(signer);
            const tx = await contractWithSigner.claim();
            const receipt = await tx.wait();

            if (!receipt) {
                throw new ContractError('Transaction receipt not available');
            }

            return {
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber
            };
        } catch (error: any) {
            throw new ContractError(
                `Failed to claim USDC: ${error.message}`,
                { error: error.message }
            );
        }
    }
}
