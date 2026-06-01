/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'ethers';
import { createSignerFromEip1193Provider } from './eip1193';

type Web3AuthModalModule = typeof import('@web3auth/modal');
type Web3AuthNetworkMap = Web3AuthModalModule['WEB3AUTH_NETWORK'];
type Web3AuthNetwork = Web3AuthNetworkMap[keyof Web3AuthNetworkMap];
type Web3AuthInstance = InstanceType<Web3AuthModalModule['Web3Auth']>;

type WalletProviderConfig = {
  clientId: string;
  network: Web3AuthNetwork;
};

function loadWalletProviderConfig(networks: Web3AuthNetworkMap): WalletProviderConfig {
  const clientId = process.env.CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      'Missing Web3Auth CLIENT_ID. Set CLIENT_ID in your environment before connect().',
    );
  }

  const rawNetwork = (process.env.WEB3AUTH_NETWORK ?? 'SAPPHIRE_DEVNET').trim().toUpperCase();
  const network = (networks as Record<string, Web3AuthNetwork>)[rawNetwork];

  if (!network) {
    throw new Error(
      `Unsupported WEB3AUTH_NETWORK="${rawNetwork}". Valid options: ${Object.keys(networks).join(', ')}`,
    );
  }

  return { clientId, network };
}

class Web3AuthWrapper {
  private web3auth: Web3AuthInstance | null = null;
  private signer: ethers.Signer | null = null;

  async connect(): Promise<ethers.Signer> {
    if (this.signer) {
      return this.signer;
    }

    const { Web3Auth, WEB3AUTH_NETWORK } = await import('@web3auth/modal');
    const config = loadWalletProviderConfig(WEB3AUTH_NETWORK);

    this.web3auth = new Web3Auth({
      clientId: config.clientId,
      web3AuthNetwork: config.network,
    });

    await this.web3auth.init();
    await this.web3auth.connect();

    if (!this.web3auth.provider) {
      throw new Error('Web3Auth provider not initialized');
    }

    this.signer = await createSignerFromEip1193Provider(this.web3auth.provider);

    return this.signer;
  }

  async getSigner(): Promise<ethers.Signer> {
    if (!this.signer) {
      throw new Error('Wallet not connected. Call connect() first.');
    }
    return this.signer;
  }

  async getAddress(): Promise<string> {
    const signer = await this.getSigner();
    return signer.getAddress();
  }

  async getChainId(): Promise<number> {
    const signer = await this.getSigner();
    if (!signer.provider) {
      throw new Error('Connected wallet signer is missing provider network context.');
    }

    const network = await signer.provider.getNetwork();
    return Number(network.chainId);
  }

  async disconnect(): Promise<void> {
    await this.web3auth?.logout();
    this.signer = null;
    this.web3auth = null;
  }
}

export const web3Wallet = new Web3AuthWrapper();
