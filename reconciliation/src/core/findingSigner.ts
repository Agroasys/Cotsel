import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { FindingSignerConfig } from '../config';

/**
 * Signs reconciliation run manifests (Cotsel#951) with ECDSA P-256 over
 * SHA-256, producing DER signatures that `crypto.verify('sha256', …)` checks.
 * The key is used for nothing else.
 */
export interface FindingSigner {
  readonly keyId: string;
  sign(message: Buffer): Promise<Buffer>;
}

/** A signing failure. The run is not completed, so its findings stay unpublished. */
export class FindingSigningError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'FindingSigningError';
    this.cause = options?.cause;
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new FindingSigningError(`${what} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Local profile only: the private key is held in the environment. */
export function createLocalFindingSigner(
  keyId: string,
  privateKeyDerBase64: string,
): FindingSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: Buffer.from(privateKeyDerBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (error) {
    throw new FindingSigningError('RECONCILIATION_FINDING_SIGNING_KEY is not a PKCS#8 key', {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new FindingSigningError('RECONCILIATION_FINDING_SIGNING_KEY must be an ECDSA P-256 key');
  }
  return {
    keyId,
    sign: async (message) => sign('sha256', message, key),
  };
}

/** Signs the SHA-256 digest with an asymmetric KMS key (ECC_NIST_P256, SIGN_VERIFY). */
export function createKmsFindingSigner(
  keyId: string,
  timeoutMs: number,
  kms: Pick<KMSClient, 'send'> = new KMSClient({}),
): FindingSigner {
  return {
    keyId,
    async sign(message) {
      const digest = createHash('sha256').update(message).digest();
      try {
        const result = await withTimeout(
          kms.send(
            new SignCommand({
              KeyId: keyId,
              Message: digest,
              MessageType: 'DIGEST',
              SigningAlgorithm: 'ECDSA_SHA_256',
            }),
          ),
          timeoutMs,
          'KMS Sign',
        );
        if (!result.Signature || result.Signature.length === 0) {
          throw new FindingSigningError('KMS Sign returned no signature');
        }
        return Buffer.from(result.Signature);
      } catch (error) {
        if (error instanceof FindingSigningError) throw error;
        throw new FindingSigningError('KMS could not sign the run manifest', { cause: error });
      }
    },
  };
}

export function createFindingSigner(
  config: FindingSignerConfig | null,
  timeoutMs: number,
): FindingSigner {
  if (!config) {
    throw new FindingSigningError(
      'RECONCILIATION_FINDING_SIGNER is not configured; findings are never published unsigned',
    );
  }
  return config.mode === 'kms'
    ? createKmsFindingSigner(config.keyId, timeoutMs)
    : createLocalFindingSigner(config.keyId, config.privateKeyDerBase64);
}

/** The SPKI public key for a local signing key, for verifier configuration and tests. */
export function localPublicKeyDerBase64(privateKeyDerBase64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyDerBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}
