import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInMemoryNonceStore } from '@agroasys/shared-auth';
import {
  AgroasysEscrow__factory,
  createServiceAuthHeaders,
  validateManagedSignerResponse,
} from '@agroasys/sdk';
import { Interface } from 'ethers';
import { createRelayerApp } from '../src/app';
import type { RelayerSigner } from '../src/kmsRelayerSigner';
import { buildSigningRequest, config, relayerWallet, serviceAuthSecret } from './helpers';

const addressPath = '/api/signers/gasless-relayer/address';
const signingPath = '/api/signers/gasless-relayer/sign-transaction';

function authHeaders(method: 'GET' | 'POST', path: string, body?: string, nonce?: string) {
  return createServiceAuthHeaders({
    apiKey: 'gateway',
    apiSecret: serviceAuthSecret,
    method,
    path,
    body,
    nonce,
  });
}

describe('gasless relayer HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  let signer: RelayerSigner;

  beforeEach(async () => {
    signer = {
      getAddress: jest.fn(async () => relayerWallet.address),
      signTransaction: jest.fn(async (request) => {
        const transaction = request.transaction;
        return relayerWallet.signTransaction({
          chainId: transaction.chainId,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
          nonce: transaction.nonce,
          gasLimit: transaction.gasLimit,
          type: transaction.type,
          ...(transaction.type === 2
            ? {
                maxFeePerGas: transaction.maxFeePerGasWei,
                maxPriorityFeePerGas: transaction.maxPriorityFeePerGasWei,
              }
            : { gasPrice: transaction.gasPriceWei }),
        });
      }),
    };
    const app = createRelayerApp(config, {
      signer,
      authNonceStore: createInMemoryNonceStore(),
      requestStore: createInMemoryNonceStore(),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test('keeps health public but protects signer identity', async () => {
    expect((await fetch(`${baseUrl}/api/relayer/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}${addressPath}`)).status).toBe(401);
    const response = await fetch(`${baseUrl}${addressPath}`, {
      headers: { ...authHeaders('GET', addressPath, undefined, 'address-once') },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signerAddress: relayerWallet.address });
  });

  test('rejects a weak service-auth secret before serving requests', () => {
    expect(() =>
      createRelayerApp(
        {
          ...config,
          apiKeysJson: JSON.stringify({ id: 'gateway', secret: 'weak-secret', active: true }),
        },
        {
          signer,
          authNonceStore: createInMemoryNonceStore(),
          requestStore: createInMemoryNonceStore(),
        },
      ),
    ).toThrow('at least 32 bytes');
  });

  test('signs only an authenticated request and returns a transaction bound to its intent', async () => {
    const request = buildSigningRequest();
    const body = JSON.stringify(request);
    const response = await fetch(`${baseUrl}${signingPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders('POST', signingPath, body, 'sign-once'),
      },
      body,
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(
      validateManagedSignerResponse(payload, {
        requestId: request.requestId,
        signerAddress: request.signerAddress,
        ...request.transaction,
      }),
    ).toMatchObject({ requestId: request.requestId, signerAddress: relayerWallet.address });
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  test('rejects an HMAC nonce replay before signing', async () => {
    const body = JSON.stringify(buildSigningRequest());
    const headers = {
      'content-type': 'application/json',
      ...authHeaders('POST', signingPath, body, 'replayed-hmac-nonce'),
    };
    expect(
      (await fetch(`${baseUrl}${signingPath}`, { method: 'POST', headers, body })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}${signingPath}`, { method: 'POST', headers, body })).status,
    ).toBe(401);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  test('rejects a consumed requestId even with fresh authentication', async () => {
    const body = JSON.stringify(buildSigningRequest());
    const send = (nonce: string) =>
      fetch(`${baseUrl}${signingPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders('POST', signingPath, body, nonce),
        },
        body,
      });
    expect((await send('request-first')).status).toBe(200);
    expect((await send('request-second')).status).toBe(409);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  test('rejects a body changed after authentication', async () => {
    const request = buildSigningRequest();
    const approvedBody = JSON.stringify(request);
    const changedBody = JSON.stringify({ ...request, operation: 'open_dispute' });
    const response = await fetch(`${baseUrl}${signingPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders('POST', signingPath, approvedBody, 'changed-body'),
      },
      body: changedBody,
    });
    expect(response.status).toBe(401);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  test('rejects direct finalization before invoking the KMS signer', async () => {
    const request = buildSigningRequest();
    const directData = new Interface(AgroasysEscrow__factory.abi).encodeFunctionData(
      'finalizeAfterDisputeWindow',
      [1n],
    );
    const body = JSON.stringify({
      ...request,
      transaction: { ...request.transaction, data: directData },
    });
    const response = await fetch(`${baseUrl}${signingPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders('POST', signingPath, body, 'direct-finalization'),
      },
      body,
    });
    expect(response.status).toBe(403);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  test('reports malformed JSON as a client error without invoking the signer', async () => {
    const body = '{';
    const response = await fetch(`${baseUrl}${signingPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders('POST', signingPath, body, 'malformed-json'),
      },
      body,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_JSON' });
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
});
