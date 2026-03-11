/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import { TradeParameters } from '../types/trade';
import { SignatureError } from '../types/errors';


export function createTradeMessageHash(
    chainId: number,
    escrowAddress: string,
    buyerAddress: string,
    treasuryAddress: string,
    params: TradeParameters,
    nonce: bigint,
    deadline: number
): string {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    
    const messageHash = ethers.keccak256(
        abiCoder.encode(
            [
                'uint256', 'address', 'address', 'address', 'address',
                'uint256', 'uint256', 'uint256', 'uint256', 'uint256',
                'bytes32', 'uint256', 'uint256'
            ],
            [
                chainId,
                escrowAddress,
                buyerAddress,
                params.supplier,
                treasuryAddress,
                params.totalAmount,
                params.logisticsAmount,
                params.platformFeesAmount,
                params.supplierFirstTranche,
                params.supplierSecondTranche,
                params.ricardianHash,
                nonce,
                deadline
            ]
        )
    );
    return messageHash;
}

export async function signTradeMessage(
    signer: ethers.Signer,
    chainId: number,
    escrowAddress: string,
    treasuryAddress: string,
    params: TradeParameters,
    nonce: bigint,
    deadline: number
): Promise<string> {
    try {
        const buyerAddress = await signer.getAddress();
        
        const messageHash = createTradeMessageHash(
            chainId,
            escrowAddress,
            buyerAddress,
            treasuryAddress,
            params,
            nonce,
            deadline
        );
        
        const signature = await signer.signMessage(ethers.getBytes(messageHash));
        return signature;
    } catch (error: any) {
        throw new SignatureError(
            `Failed to sign trade message: ${error.message}`,
            { error: error.message }
        );
    }
}
