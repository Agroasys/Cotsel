/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import { ValidationError } from '../types/errors';
import { TradeParameters } from '../types/trade';


export function validateAddress(address: string, fieldName: string): void {
    if (!ethers.isAddress(address)) {
        throw new ValidationError(`invalid ${fieldName} address`, { address, fieldName });
    }
    if (address === ethers.ZeroAddress) {
        throw new ValidationError(`${fieldName} cannot be zero address`, { address, fieldName });
    }
}


export function validateTradeParameters(params: TradeParameters): void {
    validateAddress(params.supplier, 'supplier');
    
    if (params.totalAmount <= 0n) {
        throw new ValidationError('totalAmount must be positive', { totalAmount: params.totalAmount });
    }
    if (params.logisticsAmount < 0n) {
        throw new ValidationError('logisticsAmount cannot be negative', { logisticsAmount: params.logisticsAmount });
    }
    if (params.platformFeesAmount < 0n) {
        throw new ValidationError('platformFeesAmount cannot be negative', { platformFeesAmount: params.platformFeesAmount });
    }
    if (params.supplierFirstTranche <= 0n) {
        throw new ValidationError('supplierFirstTranche must be positive', { supplierFirstTranche: params.supplierFirstTranche });
    }
    if (params.supplierSecondTranche <= 0n) {
        throw new ValidationError('supplierSecondTranche must be positive', { supplierSecondTranche: params.supplierSecondTranche });
    }
    
    const expectedTotal = 
        params.logisticsAmount + 
        params.platformFeesAmount + 
        params.supplierFirstTranche + 
        params.supplierSecondTranche;
    
    if (params.totalAmount !== expectedTotal) {
        throw new ValidationError(
            'amount breakdown does not match totalAmount',
            {
                totalAmount: params.totalAmount,
                expectedTotal,
                breakdown: {
                    logistics: params.logisticsAmount,
                    platformFees: params.platformFeesAmount,
                    firstTranche: params.supplierFirstTranche,
                    secondTranche: params.supplierSecondTranche
                }
            }
        );
    }
    
    // should be 32 bytes
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.ricardianHash)) {
        throw new ValidationError(
            'ricardianHash must be a 32-byte hex string (0x...)',
            { ricardianHash: params.ricardianHash, length: params.ricardianHash.length }
        );
    }
}

/**
 * Validates a {@link TradeParameters} before it is used to call
 * `BuyerSDK.createTrade(...)`.
 *
 * Enforces:
 * - `supplier` is a valid non-zero EVM address.
 * - `totalAmount` is positive.
 * - `logisticsAmount` and `platformFeesAmount` are >= 0.
 * - `supplierFirstTranche` and `supplierSecondTranche` are > 0.
 * - Amount invariant: `totalAmount === logisticsAmount + platformFeesAmount
 *   + supplierFirstTranche + supplierSecondTranche`.
 * - `ricardianHash` is a `0x`-prefixed 32-byte hex string.
 *
 * Throws {@link ValidationError} on the first failed constraint.
 *
 * @see {@link TradeParameters}
 */
