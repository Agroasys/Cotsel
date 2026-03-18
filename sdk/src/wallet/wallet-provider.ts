/**
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @deprecated Agroasys should own embedded-wallet bootstrap and signer
 * injection. This helper remains only for local demos and standalone SDK
 * experiments.
 */
import { Web3Auth, WEB3AUTH_NETWORK } from '@web3auth/modal';
import { ethers } from 'ethers';

type Web3AuthNetwork = (typeof WEB3AUTH_NETWORK)[keyof typeof WEB3AUTH_NETWORK];

type WalletProviderConfig = {
  clientId: string;
  network: Web3AuthNetwork;
};

function loadWalletProviderConfig(): WalletProviderConfig {
  const clientId = process.env.CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error('Missing Web3Auth CLIENT_ID. Set CLIENT_ID in your environment before connect().');
  }

  const rawNetwork = (process.env.WEB3AUTH_NETWORK ?? 'SAPPHIRE_DEVNET').trim().toUpperCase();
  const network = (WEB3AUTH_NETWORK as Record<string, Web3AuthNetwork>)[rawNetwork];

  if (!network) {
    throw new Error(
      `Unsupported WEB3AUTH_NETWORK="${rawNetwork}". Valid options: ${Object.keys(WEB3AUTH_NETWORK).join(', ')}`
    );
  }

  return { clientId, network };
}

class Web3AuthWrapper {
  private web3auth: Web3Auth | null = null;
  private signer: ethers.Signer | null = null;

  async connect(): Promise<ethers.Signer> {
    if (this.signer) {
      return this.signer;
    }

    const config = loadWalletProviderConfig();

    this.web3auth = new Web3Auth({
      clientId: config.clientId,
      web3AuthNetwork: config.network,
    });

    await this.web3auth.init();
    await this.web3auth.connect();

    if (!this.web3auth.provider) {
      throw new Error('Web3Auth provider not initialized');
    }

    const provider = new ethers.BrowserProvider(this.web3auth.provider);
    this.signer = await provider.getSigner();

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

  async disconnect(): Promise<void> {
    await this.web3auth?.logout();
    this.signer = null;
    this.web3auth = null;
  }
}

export const web3Wallet = new Web3AuthWrapper();
