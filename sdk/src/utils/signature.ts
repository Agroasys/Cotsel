/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import {
  GaslessCreateTradeAuthorization,
  GaslessUserActionAuthorization,
  SponsoredAction,
  TradeParameters,
  UsdcReceiveAuthorization,
} from '../types/trade';
import { getErrorMessage, SignatureError } from '../types/errors';

export function createTradeMessageHash(
  chainId: number,
  escrowAddress: string,
  buyerAddress: string,
  treasuryAddress: string,
  params: TradeParameters,
  nonce: bigint,
  deadline: number,
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const messageHash = ethers.keccak256(
    abiCoder.encode(
      [
        'uint256',
        'address',
        'address',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'bytes32',
        'uint256',
        'uint256',
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
        deadline,
      ],
    ),
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
  deadline: number,
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
      deadline,
    );

    const signature = await signer.signMessage(ethers.getBytes(messageHash));
    return signature;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    throw new SignatureError(`Failed to sign trade message: ${message}`, {
      error: message,
    });
  }
}

function escrowAuthorizationDomain(chainId: number, escrowAddress: string) {
  return {
    name: 'AgroasysEscrow',
    version: '1',
    chainId,
    verifyingContract: escrowAddress,
  };
}

export async function signGaslessCreateTradeAuthorization(
  signer: ethers.Signer,
  chainId: number,
  escrowAddress: string,
  params: TradeParameters,
  nonce: bigint,
  deadline: number,
): Promise<GaslessCreateTradeAuthorization> {
  try {
    const buyer = await signer.getAddress();
    const value = {
      buyer,
      supplier: params.supplier,
      totalAmount: params.totalAmount,
      logisticsAmount: params.logisticsAmount,
      platformFeesAmount: params.platformFeesAmount,
      supplierFirstTranche: params.supplierFirstTranche,
      supplierSecondTranche: params.supplierSecondTranche,
      ricardianHash: params.ricardianHash,
      nonce,
      deadline,
    };
    const signature = await signer.signTypedData(
      escrowAuthorizationDomain(chainId, escrowAddress),
      {
        CreateTradeAuthorization: [
          { name: 'buyer', type: 'address' },
          { name: 'supplier', type: 'address' },
          { name: 'totalAmount', type: 'uint256' },
          { name: 'logisticsAmount', type: 'uint256' },
          { name: 'platformFeesAmount', type: 'uint256' },
          { name: 'supplierFirstTranche', type: 'uint256' },
          { name: 'supplierSecondTranche', type: 'uint256' },
          { name: 'ricardianHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      value,
    );

    return { ...value, signature };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    throw new SignatureError(`Failed to sign gasless trade authorization: ${message}`, {
      error: message,
    });
  }
}

export async function signGaslessUserActionAuthorization(
  signer: ethers.Signer,
  chainId: number,
  escrowAddress: string,
  action: Exclude<SponsoredAction, SponsoredAction.CREATE_TRADE>,
  tradeId: string | bigint,
  nonce: bigint,
  deadline: number,
): Promise<GaslessUserActionAuthorization> {
  try {
    const user = await signer.getAddress();
    const value = {
      user,
      action,
      tradeId: BigInt(tradeId),
      nonce,
      deadline,
    };
    const signature = await signer.signTypedData(
      escrowAuthorizationDomain(chainId, escrowAddress),
      {
        UserActionAuthorization: [
          { name: 'user', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'tradeId', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      value,
    );

    return { ...value, signature };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    throw new SignatureError(`Failed to sign gasless user action authorization: ${message}`, {
      error: message,
    });
  }
}

export async function signUsdcReceiveAuthorization(
  signer: ethers.Signer,
  chainId: number,
  usdcAddress: string,
  input: {
    to: string;
    value: bigint;
    validAfter: number;
    validBefore: number;
    nonce?: string;
    tokenName?: string;
    tokenVersion?: string;
  },
): Promise<UsdcReceiveAuthorization> {
  try {
    const from = await signer.getAddress();
    const nonce = input.nonce ?? ethers.hexlify(ethers.randomBytes(32));
    const value = {
      from,
      to: input.to,
      value: input.value,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce,
    };
    const signature = await signer.signTypedData(
      {
        name: input.tokenName ?? 'USD Coin',
        version: input.tokenVersion ?? '2',
        chainId,
        verifyingContract: usdcAddress,
      },
      {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      value,
    );
    const split = ethers.Signature.from(signature);

    return {
      ...value,
      signature,
      v: split.v,
      r: split.r,
      s: split.s,
    };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    throw new SignatureError(`Failed to sign USDC receive authorization: ${message}`, {
      error: message,
    });
  }
}
