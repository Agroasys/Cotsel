import {
  generateRequestHash,
  verifyRequestSignature,
  deriveRequestNonce,
} from '../src/utils/crypto';

const runManualE2E = process.env.RUN_E2E === 'true' || process.env.RUN_MANUAL_E2E === 'true';
const describeManual = runManualE2E ? describe : describe.skip;

type JsonHttpResponse = {
  status: number;
  data: unknown;
};

type OracleSuccessResponse = {
  success: boolean;
  status?: string;
  idempotencyKey?: string;
  actionKey?: string;
  timestamp?: string;
};

function expectObject<T extends object>(value: unknown): T {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  return value as T;
}

async function jsonRequest(input: string, init?: RequestInit): Promise<JsonHttpResponse> {
  const response = await fetch(input, init);
  const text = await response.text();

  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    status: response.status,
    data,
  };
}

describe('Oracle request signing', () => {
  test('should generate and verify a valid request signature', () => {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ tradeId: '7', requestId: 'req-1' });
    const secret = 'test-secret';

    const signature = generateRequestHash(timestamp, body, secret);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);

    const result = verifyRequestSignature(timestamp, body, signature, secret);
    expect(result).toBe(true);
  });

  test('should reject tampered body signatures', () => {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ tradeId: '7', requestId: 'req-1' });
    const tamperedBody = JSON.stringify({ tradeId: '8', requestId: 'req-1' });
    const secret = 'test-secret';

    const signature = generateRequestHash(timestamp, body, secret);

    expect(() => verifyRequestSignature(timestamp, tamperedBody, signature, secret)).toThrow(
      'Invalid HMAC signature',
    );
  });

  test('should reject expired timestamp', () => {
    const timestamp = (Date.now() - 10 * 60 * 1000).toString();
    const body = JSON.stringify({ tradeId: '7', requestId: 'req-1' });
    const secret = 'test-secret';

    const signature = generateRequestHash(timestamp, body, secret);

    expect(() => verifyRequestSignature(timestamp, body, signature, secret)).toThrow(
      'Request timestamp too old',
    );
  });

  test('should derive deterministic nonce from request data', () => {
    const timestamp = '1700000000000';
    const body = JSON.stringify({ tradeId: '1', requestId: 'req-abc' });
    const signature = generateRequestHash(timestamp, body, 'secret');

    const nonce1 = deriveRequestNonce(timestamp, body, signature);
    const nonce2 = deriveRequestNonce(timestamp, body, signature);

    expect(nonce1).toMatch(/^[a-f0-9]{64}$/);
    expect(nonce1).toBe(nonce2);
  });
});

describeManual('Oracle API integration (manual)', () => {
  const API_URL = process.env.ORACLE_API_URL || 'http://localhost:3001/api/oracle';
  const API_KEY = process.env.API_KEY || '';
  const HMAC_SECRET = process.env.HMAC_SECRET || '';

  function signedHeaders(body: Record<string, unknown>) {
    const timestamp = Date.now().toString();
    const bodyStr = JSON.stringify(body);
    const signature = generateRequestHash(timestamp, bodyStr, HMAC_SECRET);
    const nonce = deriveRequestNonce(timestamp, bodyStr, signature);

    return {
      Authorization: `Bearer ${API_KEY}`,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'X-Nonce': nonce,
      'Content-Type': 'application/json',
    };
  }

  test('GET /health returns ok', async () => {
    const response = await jsonRequest(`${API_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      success: true,
      status: 'ok',
    });
  });

  test('GET /ready returns ready', async () => {
    const response = await jsonRequest(`${API_URL}/ready`);
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      ready: true,
    });
  });

  test.skip('rejects request without Authorization header', async () => {
    const payload = { tradeId: '1', requestId: `test-${Date.now()}` };
    const response = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(401);
  });

  test.skip('rejects request with invalid API key', async () => {
    const payload = { tradeId: '1', requestId: `test-${Date.now()}` };
    const timestamp = Date.now().toString();
    const bodyStr = JSON.stringify(payload);
    const signature = generateRequestHash(timestamp, bodyStr, HMAC_SECRET);
    const nonce = deriveRequestNonce(timestamp, bodyStr, signature);

    const response = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-api-key',
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        'X-Nonce': nonce,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(401);
  });

  test.skip('rejects request without HMAC headers', async () => {
    const payload = { tradeId: '1', requestId: `test-${Date.now()}` };
    const response = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(401);
  });

  test.skip('POST /release-stage1 accepts signed request', async () => {
    const payload = { tradeId: '8', requestId: `test-${Date.now()}` };

    const response = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = expectObject<OracleSuccessResponse>(response.data);
    expect(data.success).toBe(true);
    expect(data).toMatchObject({
      success: true,
      idempotencyKey: expect.any(String),
      actionKey: expect.stringContaining('RELEASE_STAGE_1'),
      status: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  test.skip('POST /confirm-arrival accepts signed request', async () => {
    const payload = { tradeId: '2', requestId: `test-${Date.now()}` };

    const response = await jsonRequest(`${API_URL}/confirm-arrival`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = expectObject<OracleSuccessResponse>(response.data);
    expect(data.success).toBe(true);
    expect(data).toMatchObject({
      success: true,
      idempotencyKey: expect.any(String),
      actionKey: expect.stringContaining('CONFIRM_ARRIVAL'),
      status: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  test.skip('POST /finalize-trade accepts signed request', async () => {
    const payload = { tradeId: '0', requestId: `test-${Date.now()}` };

    const response = await jsonRequest(`${API_URL}/finalize-trade`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = expectObject<OracleSuccessResponse>(response.data);
    expect(data.success).toBe(true);
    expect(data).toMatchObject({
      success: true,
      idempotencyKey: expect.any(String),
      actionKey: expect.stringContaining('FINALIZE_TRADE'),
      status: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  test.skip('POST /redrive accepts signed request', async () => {
    const payload = {
      tradeId: '1',
      triggerType: 'release-stage1',
      requestId: `redrive-${Date.now()}`,
    };

    const response = await jsonRequest(`${API_URL}/redrive`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = expectObject<OracleSuccessResponse>(response.data);
    expect(data.success).toBe(true);
    expect(data).toMatchObject({
      success: true,
      idempotencyKey: expect.any(String),
      actionKey: expect.any(String),
      status: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  test.skip('POST /redrive rejects missing triggerType', async () => {
    const payload = { tradeId: '1', requestId: `test-${Date.now()}` };

    const response = await jsonRequest(`${API_URL}/redrive`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  test.skip('rejects missing tradeId', async () => {
    const payload = { requestId: `test-${Date.now()}` };

    const response = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  test.skip('POST /approve approves a PENDING_APPROVAL trigger and executes it', async () => {
    const submitPayload = { tradeId: '9', requestId: `test-approve-${Date.now()}` };

    const submitResponse = await jsonRequest(`${API_URL}/release-stage1`, {
      method: 'POST',
      headers: signedHeaders(submitPayload),
      body: JSON.stringify(submitPayload),
    });

    expect(submitResponse.status).toBe(200);
    const submitData = expectObject<OracleSuccessResponse>(submitResponse.data);
    expect(submitData.status).toBe('PENDING_APPROVAL');

    const { idempotencyKey } = submitData;
    expect(idempotencyKey).toBeTruthy();

    const approvePayload = {
      idempotencyKey,
      actor: 'operator@agroasys',
    };

    const approveResponse = await jsonRequest(`${API_URL}/approve`, {
      method: 'POST',
      headers: signedHeaders(approvePayload),
      body: JSON.stringify(approvePayload),
    });

    expect(approveResponse.status).toBe(200);
    const approveData = expectObject<OracleSuccessResponse>(approveResponse.data);
    expect(approveData.success).toBe(true);
  });

  test.skip('POST /reject rejects a PENDING_APPROVAL trigger with audit trail', async () => {
    const submitPayload = { tradeId: '9', requestId: `test-reject-${Date.now()}` };

    const submitResponse = await jsonRequest(`${API_URL}/confirm-arrival`, {
      method: 'POST',
      headers: signedHeaders(submitPayload),
      body: JSON.stringify(submitPayload),
    });

    expect(submitResponse.status).toBe(200);
    const submitData = expectObject<OracleSuccessResponse>(submitResponse.data);
    expect(submitData.status).toBe('PENDING_APPROVAL');

    const { idempotencyKey } = submitData;
    expect(idempotencyKey).toBeTruthy();

    const rejectPayload = {
      idempotencyKey,
      actor: 'oncall@agroasys',
      reason: 'issue during pilot review',
    };

    const rejectResponse = await jsonRequest(`${API_URL}/reject`, {
      method: 'POST',
      headers: signedHeaders(rejectPayload),
      body: JSON.stringify(rejectPayload),
    });

    expect(rejectResponse.status).toBe(200);
    const rejectData = expectObject<OracleSuccessResponse>(rejectResponse.data);
    expect(rejectData.success).toBe(true);
  });

  test.skip('POST /approve returns 400 when idempotencyKey is missing', async () => {
    const payload = { actor: 'operator@agroasys' };

    const response = await jsonRequest(`${API_URL}/approve`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  test.skip('POST /reject returns 400 when actor is missing', async () => {
    const payload = { idempotencyKey: 'some-key' };

    const response = await jsonRequest(`${API_URL}/reject`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  test.skip('POST /approve returns 400 when trigger does not exist', async () => {
    const payload = {
      idempotencyKey: 'non-existent-key-000000000000',
      actor: 'operator@agroasys',
    };

    const response = await jsonRequest(`${API_URL}/approve`, {
      method: 'POST',
      headers: signedHeaders(payload),
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });
});
