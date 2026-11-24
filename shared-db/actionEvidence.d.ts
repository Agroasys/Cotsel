import type { KeyObject } from 'node:crypto';
export function attestActionEvidence<T extends object>(
  body: T,
  options: {
    challenge: string;
    resource: string;
    now?: number;
    signer: { keyId: string; sign(message: Buffer): Promise<Buffer> };
  },
): Promise<T & { attestation: unknown }>;
export function verifyActionEvidence(
  response: unknown,
  options: {
    challenge: string;
    resource: string;
    now?: number;
    context: { chainId: number | null; escrowAddress: string };
    publicKeys: ReadonlyMap<string, KeyObject>;
  },
): boolean;
