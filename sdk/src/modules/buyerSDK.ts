/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Client } from '../client';
import { TradeParameters, TradeResult } from '../types/trade';
import { ethers } from 'ethers';
import { validateTradeParameters, validateAddress } from '../utils/validation';
import { signTradeMessage } from '../utils/signature';
import { ContractError } from '../types/errors';
import { IERC20__factory } from '../types/typechain-types/factories/@openzeppelin/contracts/token/ERC20/IERC20__factory';

export class BuyerSDK extends Client {

    async getBuyerNonce(buyerAddress: string): Promise<bigint> {
        validateAddress(buyerAddress, 'buyer');
        return super.getBuyerNonce(buyerAddress);
    }
    
    async approveUSDC(amount: bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
        try {
            const usdcContract = IERC20__factory.connect(
                this.config.usdcAddress,
                buyerSigner
            );
            
            const tx = await usdcContract.approve(
                this.config.escrowAddress,
                amount
            );
            
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
                `Failed to approve USDC: ${error.message}`,
                { amount: amount.toString(), error: error.message }
            );
        }
    }
    
    async getUSDCAllowance(buyerAddress: string): Promise<bigint> {
        try {
            const usdcContract = IERC20__factory.connect(
                this.config.usdcAddress,
                this.provider
            );
            
            return await usdcContract.allowance(
                buyerAddress,
                this.config.escrowAddress
            );
            
        } catch (error: any) {
            throw new ContractError(
                `Failed to get USDC allowance: ${error.message}`,
                { buyerAddress, error: error.message }
            );
        }
    }
    
    async getUSDCBalance(buyerAddress: string): Promise<bigint> {
        try {
            const usdcContract = IERC20__factory.connect(
                this.config.usdcAddress,
                this.provider
            );
            
            return await usdcContract.balanceOf(buyerAddress);
            
        } catch (error: any) {
            throw new ContractError(
                `Failed to get USDC balance: ${error.message}`,
                { buyerAddress, error: error.message }
            );
        }
    }
    
    async createTrade(params: TradeParameters, buyerSigner: ethers.Signer): Promise<TradeResult> {
        validateTradeParameters(params);
        
        const buyerAddress = await buyerSigner.getAddress();
        
        const currentAllowance = await this.getUSDCAllowance(buyerAddress);
        
        if (currentAllowance < params.totalAmount) {
            await this.approveUSDC(params.totalAmount, buyerSigner);
        }

        const nonce = await this.getBuyerNonce(buyerAddress);
        
        const deadline = params.deadline || Math.floor(Date.now() / 1000) + 3600;
        
        const treasuryAddress = await this.getTreasuryAddress();
        
        const signature = await signTradeMessage(
            buyerSigner,
            this.config.chainId,
            this.config.escrowAddress,
            treasuryAddress,
            params,
            nonce,
            deadline
        );
        
        try {
            const contractWithSigner = this.contract.connect(buyerSigner);
            
            const tx = await contractWithSigner.createTrade(
                params.supplier,
                params.totalAmount,
                params.logisticsAmount,
                params.platformFeesAmount,
                params.supplierFirstTranche,
                params.supplierSecondTranche,
                params.ricardianHash,
                nonce,
                deadline,
                signature
            );
            
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
                `Failed to create trade: ${error.message}`,
                { 
                    error: error.message,
                    params: {
                        supplier: params.supplier,
                        totalAmount: params.totalAmount.toString(),
                        ricardianHash: params.ricardianHash
                    }
                }
            );
        }
    }
    
    async openDispute(tradeId: string | bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
        try {
            const contractWithSigner = this.contract.connect(buyerSigner);
            const tx = await contractWithSigner.openDispute(tradeId);
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
                `Failed to open dispute: ${error.message}`,
                { tradeId: tradeId.toString(), error: error.message }
            );
        }
    }


    async cancelLockedTradeAfterTimeout(tradeId: string | bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
        try {
            const contractWithSigner = this.contract.connect(buyerSigner);
            const tx = await contractWithSigner.cancelLockedTradeAfterTimeout(tradeId);
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
                `Failed to cancel locked trade: ${error.message}`,
                { tradeId: tradeId.toString(), error: error.message }
            );
        }
    }

    async refundInTransitAfterTimeout(tradeId: string | bigint, buyerSigner: ethers.Signer): Promise<TradeResult> {
        try {
            const contractWithSigner = this.contract.connect(buyerSigner);
            const tx = await contractWithSigner.refundInTransitAfterTimeout(tradeId);
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
                `Failed to refund in-transit trade: ${error.message}`,
                { tradeId: tradeId.toString(), error: error.message }
            );
        }
    }
}
