/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { AbstractProvider, ethers } from 'ethers';
import { Config } from './config';
import { ContractError, getErrorMessage } from './types/errors';
import { AgroasysEscrow__factory } from './types/typechain-types/factories/src/AgroasysEscrow.sol/AgroasysEscrow__factory';
import type { AgroasysEscrow } from './types/typechain-types/src/AgroasysEscrow.sol/AgroasysEscrow';
import { createManagedRpcProvider } from './rpc/failoverProvider';
import type { RuntimeRoleExpectations } from './config';
import type { RuntimePreflightFailureCode, RuntimePreflightResult } from './types/runtimePreflight';

const CANONICAL_USDC_BY_CHAIN = new Map<number, string>([
  [84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class Client {
  protected provider: AbstractProvider;
  protected contract: AgroasysEscrow;

  constructor(protected config: Config) {
    this.provider = createManagedRpcProvider(config.rpc, config.rpcFallbackUrls, {
      chainId: config.chainId,
      quorum: config.rpcQuorum,
      stallTimeoutMs: config.rpcStallTimeoutMs,
    });
    this.contract = AgroasysEscrow__factory.connect(config.escrowAddress, this.provider);
  }

  async preflightRuntime(
    expectedRoles: RuntimeRoleExpectations | undefined = this.config.expectedRuntimeRoles,
  ): Promise<RuntimePreflightResult> {
    const failureCodes = new Set<RuntimePreflightFailureCode>();
    const observation: RuntimePreflightResult['observation'] = {
      chainId: null,
      escrowAddress: this.config.escrowAddress,
      codePresent: false,
      usdcAddress: null,
      oracleAddress: null,
      treasuryAddress: null,
      treasuryPayoutAddress: null,
      oracleActive: null,
      requiredApprovals: null,
    };

    if (!ethers.isAddress(this.config.escrowAddress)) {
      failureCodes.add('INVALID_CONTRACT_ADDRESS');
      return { ok: false, failureCodes: [...failureCodes], observation };
    }

    try {
      const network = await this.provider.getNetwork();
      observation.chainId = Number(network.chainId);
      if (network.chainId !== BigInt(this.config.chainId)) {
        failureCodes.add('WRONG_CHAIN');
      }

      const code = await this.provider.getCode(this.config.escrowAddress);
      observation.codePresent = code !== '0x';
      if (!observation.codePresent) {
        failureCodes.add('CONTRACT_CODE_MISSING');
      }
    } catch {
      failureCodes.add('RPC_UNAVAILABLE');
      return { ok: false, failureCodes: [...failureCodes], observation };
    }

    if (observation.codePresent) {
      try {
        const [
          usdcAddress,
          oracleAddress,
          treasuryAddress,
          treasuryPayoutAddress,
          oracleActive,
          requiredApprovals,
        ] = await Promise.all([
          this.contract.usdcToken(),
          this.contract.oracleAddress(),
          this.contract.treasuryAddress(),
          this.contract.treasuryPayoutAddress(),
          this.contract.oracleActive(),
          this.contract.requiredApprovals(),
        ]);
        observation.usdcAddress = usdcAddress;
        observation.oracleAddress = oracleAddress;
        observation.treasuryAddress = treasuryAddress;
        observation.treasuryPayoutAddress = treasuryPayoutAddress;
        observation.oracleActive = oracleActive;
        observation.requiredApprovals = Number(requiredApprovals);

        const canonicalUsdc = CANONICAL_USDC_BY_CHAIN.get(this.config.chainId);
        if (
          !sameAddress(usdcAddress, this.config.usdcAddress) ||
          (canonicalUsdc !== undefined && !sameAddress(usdcAddress, canonicalUsdc))
        ) {
          failureCodes.add('WRONG_USDC');
        }

        if (!expectedRoles) {
          failureCodes.add('ROLE_EXPECTATIONS_MISSING');
        } else {
          const observedAdmins = await Promise.all(
            expectedRoles.adminAddresses.map((_address, index) => this.contract.admins(index)),
          );
          let extraAdminExists = false;
          try {
            await this.contract.admins(expectedRoles.adminAddresses.length);
            extraAdminExists = true;
          } catch {
            extraAdminExists = false;
          }
          const roleChecks = await Promise.all([
            ...expectedRoles.adminAddresses.map((address) => this.contract.isAdmin(address)),
            ...expectedRoles.relayerAddresses.map((address) => this.contract.isRelayer(address)),
          ]);
          const rolesMatch =
            sameAddress(oracleAddress, expectedRoles.oracleAddress) &&
            sameAddress(treasuryAddress, expectedRoles.treasuryAddress) &&
            sameAddress(treasuryPayoutAddress, expectedRoles.treasuryPayoutAddress) &&
            oracleActive &&
            Number(requiredApprovals) === expectedRoles.requiredApprovals &&
            observedAdmins.every((address, index) =>
              sameAddress(address, expectedRoles.adminAddresses[index]),
            ) &&
            !extraAdminExists &&
            roleChecks.every(Boolean);
          if (!rolesMatch) {
            failureCodes.add('ROLE_STATE_MISMATCH');
          }
        }
      } catch {
        failureCodes.add('CONTRACT_READ_FAILED');
      }
    }

    return {
      ok: failureCodes.size === 0,
      failureCodes: [...failureCodes],
      observation,
    };
  }

  protected async assertSignerCompatibility(
    signer: ethers.Signer,
    signerLabel = 'Signer',
  ): Promise<void> {
    if (!signer.provider) {
      throw new ContractError(`${signerLabel} is missing a connected provider`);
    }

    const signerNetwork = await signer.provider.getNetwork();
    if (signerNetwork.chainId !== BigInt(this.config.chainId)) {
      throw new ContractError(
        `${signerLabel} is connected to the wrong network for this settlement target`,
        {
          expectedChainId: this.config.chainId,
          actualChainId: signerNetwork.chainId.toString(),
        },
      );
    }
  }

  async getTreasuryAddress(): Promise<string> {
    try {
      return await this.contract.treasuryAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get treasury address: ${message}`, {
        error: message,
      });
    }
  }

  async getTreasuryPayoutAddress(): Promise<string> {
    try {
      return await this.contract.treasuryPayoutAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get treasury payout address: ${message}`, {
        error: message,
      });
    }
  }

  async getOracleAddress(): Promise<string> {
    try {
      return await this.contract.oracleAddress();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get oracle address: ${message}`, {
        error: message,
      });
    }
  }

  async isAdmin(address: string): Promise<boolean> {
    try {
      return await this.contract.isAdmin(address);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check admin status: ${message}`, {
        address,
        error: message,
      });
    }
  }

  async isPaused(): Promise<boolean> {
    try {
      return await this.contract.paused();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check paused state: ${message}`, {
        error: message,
      });
    }
  }

  async isTradePaused(tradeId: bigint): Promise<boolean> {
    try {
      return await this.contract.tradePaused(tradeId);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check tradePaused state: ${message}`, {
        tradeId: tradeId.toString(),
        error: message,
      });
    }
  }

  async isClaimsPaused(): Promise<boolean> {
    try {
      return await this.contract.claimsPaused();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to check claimsPaused state: ${message}`, {
        error: message,
      });
    }
  }

  async getClaimableUsdc(address: string): Promise<bigint> {
    try {
      return await this.contract.claimableUsdc(address);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get claimable USDC: ${message}`, {
        address,
        error: message,
      });
    }
  }

  async getAuthorizationNonce(userAddress: string): Promise<bigint> {
    try {
      return await this.contract.getAuthorizationNonce(userAddress);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get authorization nonce: ${message}`, {
        userAddress,
        error: message,
      });
    }
  }

  async getTotalClaimableUsdc(): Promise<bigint> {
    try {
      return await this.contract.totalClaimableUsdc();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      throw new ContractError(`Failed to get total claimable USDC: ${message}`, {
        error: message,
      });
    }
  }
}
