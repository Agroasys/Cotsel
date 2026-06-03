#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  Contract,
  JsonRpcProvider,
  Signature,
  Wallet,
  formatUnits,
  keccak256,
  parseUnits,
  toUtf8Bytes,
} = require('ethers');

const WINDOW_ID = process.env.WINDOW_ID || 'PILOT-2026-05-29';
const COTSEL_ROOT = path.resolve(__dirname, '..');
const BACKEND_ROOT =
  process.env.AGROASYS_BACKEND_ROOT || path.resolve(COTSEL_ROOT, '..', 'agroasys-backend');
const REPORT_DIR = path.join(COTSEL_ROOT, 'reports', 'base-sepolia-pilot-validation', WINDOW_ID);
const REPORT_PATH = path.join(REPORT_DIR, 'live-base-sepolia-proof.json');

const ESCROW_ABI = require('../contracts/artifacts/src/AgroasysEscrow.sol/AgroasysEscrow.json').abi;
const ERC20_ABI = [
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function parseEnvFile(filePath) {
  const values = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = rawLine.indexOf('=');
    let value = rawLine.slice(index + 1);
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    values[rawLine.slice(0, index)] = value;
  }
  return values;
}

function requireEnv(values, name) {
  const value = values[name] || process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function requireNumberEnv(values, name) {
  const raw = requireEnv(values, name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseJsonStringArrayEnv(values, name) {
  const raw = requireEnv(values, name);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON array of strings`, { cause: error });
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }

  return parsed.map((value) => value.trim());
}

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

async function assertWalletHasGas({ provider, wallet, label }) {
  const balance = await provider.getBalance(wallet.address);
  const floor = parseUnits('0.00003', 18);
  if (balance < floor) {
    throw new Error(
      `${label} ${wallet.address} needs Base Sepolia ETH for service/admin gas. ` +
        `Do not fund buyer or supplier wallets; fund the service/admin wallet instead.`,
    );
  }
}

async function loadDisputeApprovers({ provider, escrow, cotselEnv, wallets }) {
  const requiredApprovals = Number(await escrow.requiredApprovals());
  if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 2) {
    throw new Error(`Invalid escrow requiredApprovals value: ${requiredApprovals}`);
  }

  const buyerIsAdmin = await escrow.isAdmin(wallets.buyer);
  const supplierIsAdmin = await escrow.isAdmin(wallets.supplier);
  if (buyerIsAdmin) {
    throw new Error(
      `Buyer wallet ${wallets.buyer} is configured as an escrow admin. ` +
        'Redeploy with service-owned admins before running live proof.',
    );
  }
  if (supplierIsAdmin) {
    throw new Error(
      `Supplier wallet ${wallets.supplier} is configured as an escrow admin. ` +
        'Redeploy with service-owned admins before running live proof.',
    );
  }

  const approverKeys = parseJsonStringArrayEnv(
    cotselEnv,
    'PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON',
  );
  const approvers = approverKeys.map((key) => new Wallet(key, provider));
  const uniqueAddresses = new Set(approvers.map((wallet) => wallet.address.toLowerCase()));
  if (uniqueAddresses.size !== approvers.length) {
    throw new Error('PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON must not contain duplicate wallets');
  }
  if (approvers.length < requiredApprovals) {
    throw new Error(
      `PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON must contain at least ${requiredApprovals} ` +
        'distinct non-user admin wallets',
    );
  }

  for (const [index, approver] of approvers.entries()) {
    if (
      sameAddress(approver.address, wallets.buyer) ||
      sameAddress(approver.address, wallets.supplier)
    ) {
      throw new Error(
        `PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON[${index}] derives to a buyer/supplier user wallet. ` +
          'Use service-owned admin wallets only.',
      );
    }
    if (!(await escrow.isAdmin(approver.address))) {
      throw new Error(
        `PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON[${index}] derives to ${approver.address}, ` +
          'which is not an escrow admin for the deployed contract.',
      );
    }
    const code = await provider.getCode(approver.address);
    if (code !== '0x') {
      throw new Error(
        `PILOT_DISPUTE_APPROVER_PRIVATE_KEYS_JSON[${index}] derives to ${approver.address}, ` +
          'which has deployed code. Use a plain service-owned EOA admin wallet for live proof.',
      );
    }
    await assertWalletHasGas({ provider, wallet: approver, label: `Dispute approver ${index}` });
  }

  return {
    requiredApprovals,
    wallets: approvers.slice(0, requiredApprovals),
    addresses: approvers.slice(0, requiredApprovals).map((wallet) => wallet.address),
  };
}

function serviceAuthHeaders({ apiKey, apiSecret, method, path: requestPath, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyBuffer =
    body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const bodySha256 = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
  const canonical = [method.toUpperCase(), requestPath, '', bodySha256, timestamp, nonce].join(
    '\n',
  );
  const signature = crypto.createHmac('sha256', apiSecret).update(canonical).digest('hex');
  return {
    'X-Api-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

async function gatewayRequest({
  baseUrl,
  apiKey,
  apiSecret,
  method = 'POST',
  route,
  body,
  idempotencyKey,
}) {
  const requestPath = `/api/dashboard-gateway/v1${route}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...serviceAuthHeaders({ apiKey, apiSecret, method, path: requestPath, body }),
    },
    body: body === null || body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    payload,
  };
}

async function gatewayJson(input) {
  const response = await gatewayRequest(input);
  if (!response.ok) {
    throw new Error(
      `${input.method || 'POST'} ${input.route} failed ${response.status}: ${JSON.stringify(
        response.payload,
      )}`,
    );
  }
  return response.payload;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function payloadHash(payload) {
  return keccak256(toUtf8Bytes(stableJson(payload)));
}

async function expectGatewayFailure({
  expectedStatus,
  expectedCode,
  expectedMessageIncludes,
  ...request
}) {
  const response = await gatewayRequest(request);
  const errorPayload = response.payload?.error ?? {};
  const errorMessage = String(errorPayload.message ?? response.payload?.message ?? '');
  const errorCode = errorPayload.code ?? response.payload?.code ?? null;
  const passed =
    response.status === expectedStatus &&
    (!expectedCode || errorCode === expectedCode) &&
    (!expectedMessageIncludes || errorMessage.includes(expectedMessageIncludes));
  return {
    route: request.route,
    idempotencyKey: request.idempotencyKey ?? null,
    expectedStatus,
    actualStatus: response.status,
    expectedCode: expectedCode ?? null,
    actualCode: errorCode,
    expectedMessageIncludes: expectedMessageIncludes ?? null,
    message: errorMessage,
    passed,
    noTxExpected: true,
  };
}

function operatorEvidenceRef(values, name) {
  const value = values[name] || process.env[name] || '';
  return value.trim() ? { status: 'provided', evidenceRef: value.trim() } : null;
}

function readOperatorEvidencePacket(values, name, scenario) {
  const reference = operatorEvidenceRef(values, name);
  if (!reference) {
    return {
      scenario,
      status: 'missing',
      evidenceRef: null,
      sourceEnv: name,
      error: `${name} is required and must point to a structured JSON evidence file`,
    };
  }

  const evidencePath = path.isAbsolute(reference.evidenceRef)
    ? reference.evidenceRef
    : path.resolve(COTSEL_ROOT, reference.evidenceRef);
  if (!fs.existsSync(evidencePath)) {
    return {
      scenario,
      status: 'invalid',
      evidenceRef: reference.evidenceRef,
      sourceEnv: name,
      error: `Evidence file does not exist: ${reference.evidenceRef}`,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    return {
      ...parsed,
      scenario: parsed.scenario ?? scenario,
      evidenceRef: parsed.evidenceRef ?? reference.evidenceRef,
      sourceEnv: name,
      sourcePath: reference.evidenceRef,
    };
  } catch (error) {
    return {
      scenario,
      status: 'invalid',
      evidenceRef: reference.evidenceRef,
      sourceEnv: name,
      error: error instanceof Error ? error.message : 'Unable to parse structured evidence file',
    };
  }
}

function isIdempotencyInProgress(response) {
  if (response.status !== 409) return false;
  const message = String(response.payload?.error?.message ?? response.payload?.message ?? '');
  return message.includes('already in progress');
}

async function waitForIdempotentReplay(request, attempts = 8, delayMs = 250) {
  let latest = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await gatewayRequest(request);
    if (!isIdempotencyInProgress(latest)) {
      return { ...latest, attempts };
    }
    await wait(delayMs * attempt);
  }
  return { ...latest, attempts };
}

async function waitForTx(tx) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`transaction failed: ${tx.hash}`);
  }
  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasPrice: receipt.gasPrice?.toString() || null,
    nativeCostWei: receipt.gasPrice ? (receipt.gasUsed * receipt.gasPrice).toString() : null,
  };
}

async function seedBackend({
  backendEnv,
  requestId,
  amounts,
  wallets,
  escrowAddress,
  usdcAddress,
  chainId,
}) {
  const client = new Client({ connectionString: requireEnv(backendEnv, 'DATABASE_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    const buyer = await upsertPilotUser(client, {
      fullName: 'Pilot Buyer',
      username: `pilot_buyer_${WINDOW_ID.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      email: `pilot-buyer-${WINDOW_ID.toLowerCase()}@agroasys.local`,
      role: 'BUYER',
    });
    await upsertPilotUser(client, {
      fullName: 'Pilot Supplier',
      username: `pilot_supplier_${WINDOW_ID.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      email: `pilot-supplier-${WINDOW_ID.toLowerCase()}@agroasys.local`,
      role: 'SUPPLIER',
    });
    const order = await client.query(
      `INSERT INTO orders (
         "updatedAt", "buyerId", status, "partialPayment", "deliveryAddress",
         "logisticsFee", "settlementChannel", "settlementReference", "ricardianHash",
         "financialTermsLockedAt"
       ) VALUES (NOW(), $1, 'PROCESSING', 'PERCENT_30', $2, $3, 'web3', $4, $5, NOW())
       RETURNING id`,
      [
        buyer.id,
        'Pilot Base Sepolia delivery address',
        '1.00',
        `PILOT-${requestId}`,
        amounts.ricardianHash,
      ],
    );
    const orderId = order.rows[0].id;
    await client.query(
      `INSERT INTO settlement_sponsorship_requests (
         "requestId", "updatedAt", "orderId", "actorUserId", action, status, endpoint,
         "idempotencyKey", "requestFingerprint", "policyVersion", "chainId", "contractAddress",
         "usdcAddress", "buyerWalletAddress", "supplierWalletAddress",
         "tradePrincipalAmountBaseUnits", "totalAmountBaseUnits", "logisticsAmountBaseUnits",
         "buyerPlatformFeeBaseUnits", "settlementSupportFeeBaseUnits",
         "treasuryAccrualAmountBaseUnits", "platformFeesAmountBaseUnits",
         "supplierFirstTrancheBaseUnits", "supplierSecondTrancheBaseUnits",
         "ricardianHash", "authorizationReceivedAt", "policyApprovedAt", "decisionMetadata"
       ) VALUES (
         $1, NOW(), $2, $3, 'create_trade', 'awaiting_cotsel',
         '/api/v1/settlement-handoffs/orders/:orderId/gasless-sponsorships/create-trade',
         $4, $5, 'pilot-live-base-sepolia-v1', $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW(), NOW(), $21::jsonb
       )`,
      [
        requestId,
        orderId,
        buyer.id,
        `pilot-${requestId}`,
        crypto.createHash('sha256').update(requestId).digest('hex'),
        String(chainId),
        escrowAddress,
        usdcAddress,
        wallets.buyer,
        wallets.supplier,
        (amounts.supplierFirstTranche + amounts.supplierSecondTranche).toString(),
        amounts.total.toString(),
        amounts.logistics.toString(),
        '0',
        parseUnits('4', 6).toString(),
        (amounts.logistics + amounts.platformFees).toString(),
        amounts.platformFees.toString(),
        amounts.supplierFirstTranche.toString(),
        amounts.supplierSecondTranche.toString(),
        amounts.ricardianHash,
        JSON.stringify({ windowId: WINDOW_ID, seededFor: 'live-base-sepolia-proof' }),
      ],
    );
    await client.query('COMMIT');
    return { orderId, buyerUserId: buyer.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function upsertPilotUser(client, input) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [
    input.email,
  ]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await client.query(
    `INSERT INTO users ("updatedAt", "fullName", username, email, password, role, kyc_status)
     VALUES (NOW(), $1, $2, $3, 'pilot-seed-not-for-login', $4, 'APPROVED')
     RETURNING id`,
    [input.fullName, input.username, input.email, input.role],
  );
  return created.rows[0];
}

async function seedBackendRefundHandoff({ backendEnv, orderId, tradeId, amounts }) {
  const client = new Client({ connectionString: requireEnv(backendEnv, 'DATABASE_URL') });
  await client.connect();
  try {
    const inserted = await client.query(
      `INSERT INTO settlement_handoffs (
         "updatedAt", "orderId", "triggerType", status, "releasePercentage",
         "externalReference", "reconciliationStatus", "controlState", payload
       ) VALUES (
         NOW(), $1, 'dispute_resolved_final_release', 'dispatched', 60.00,
         $2, 'pending', 'normal', $3::jsonb
       ) RETURNING id`,
      [
        orderId,
        String(tradeId),
        JSON.stringify({
          expected: {
            supplierPayoutUsd: Number(formatUnits(amounts.supplierFirstTranche, 6)),
            treasuryClaimableUsd: Number(formatUnits(amounts.logistics + amounts.platformFees, 6)),
            buyerRefundUsd: Number(formatUnits(amounts.supplierSecondTranche, 6)),
          },
        }),
      ],
    );
    return { handoffId: inserted.rows[0].id };
  } finally {
    await client.end();
  }
}

async function updateBackendRefundHandoffRemoteId({ backendEnv, handoffId, remoteHandoffId }) {
  const client = new Client({ connectionString: requireEnv(backendEnv, 'DATABASE_URL') });
  await client.connect();
  try {
    await client.query(
      `UPDATE settlement_handoffs
       SET payload = COALESCE(payload, '{}'::jsonb) || $1::jsonb,
           "updatedAt" = NOW()
       WHERE id = $2`,
      [JSON.stringify({ cotsel: { handoffId: remoteHandoffId } }), handoffId],
    );
  } finally {
    await client.end();
  }
}

async function readBackendEvidence(backendEnv, requestId, regularHandoffId) {
  const client = new Client({ connectionString: requireEnv(backendEnv, 'DATABASE_URL') });
  await client.connect();
  try {
    const sponsorship = await client.query(
      `SELECT id, "requestId", status, "cotselHandoffId", "cotselTxHash", "chainConfirmedAt", "cotselResponsePayload"
       FROM settlement_sponsorship_requests WHERE "requestId" = $1`,
      [requestId],
    );
    const accounting = await client.query(
      `SELECT id, request_id, tx_hash, execution_sender_address, block_number, execution_succeeded,
              gas_used, effective_gas_price_wei, native_cost_wei, accounting_status, metadata
       FROM settlement_sponsorship_accounting_entries WHERE request_id = $1`,
      [requestId],
    );
    const handoff = await client.query(
      `SELECT id, "orderId", status, "externalReference", "reconciliationStatus", "externalTransactionHash",
              "lastReconciledAt", payload
       FROM settlement_handoffs WHERE id = $1`,
      [regularHandoffId],
    );
    const events = await client.query(
      `SELECT id, "eventType", "sourceSystem", "sourceEventId", "externalTransactionHash",
              "observedSupplierClaimableCents", "observedTreasuryClaimableCents",
              "observedBuyerRefundCents", payload
       FROM settlement_execution_events WHERE "handoffId" = $1 ORDER BY id`,
      [regularHandoffId],
    );
    return {
      sponsorship: sponsorship.rows,
      accounting: accounting.rows,
      refundHandoff: handoff.rows,
      refundEvents: events.rows,
    };
  } finally {
    await client.end();
  }
}

async function readGatewayEvidence(cotselEnv, handoffIds) {
  const client = new Client({
    host: '127.0.0.1',
    port: Number(requireEnv(cotselEnv, 'POSTGRES_PORT')),
    database: requireEnv(cotselEnv, 'GATEWAY_DB_NAME'),
    user: requireEnv(cotselEnv, 'GATEWAY_DB_RUNTIME_USER'),
    password: requireEnv(cotselEnv, 'GATEWAY_DB_RUNTIME_PASSWORD'),
    options: '-c app.service_name=gateway',
  });
  await client.connect();
  try {
    const handoffs = await client.query(
      `SELECT handoff_id AS "handoffId", execution_status AS "executionStatus",
              reconciliation_status AS "reconciliationStatus", callback_status AS "callbackStatus",
              tx_hash AS "txHash", latest_event_type AS "latestEventType",
              callback_delivered_at AS "callbackDeliveredAt"
       FROM settlement_handoffs
       WHERE handoff_id = ANY($1::text[])
       ORDER BY created_at`,
      [handoffIds],
    );
    const callbackDeliveries = await client.query(
      `SELECT deliveries.delivery_id AS "deliveryId", deliveries.handoff_id AS "handoffId",
              events.event_type AS "eventType", events.execution_status AS "executionStatus",
              events.reconciliation_status AS "reconciliationStatus",
              deliveries.status, deliveries.attempt_count AS "attemptCount",
              deliveries.response_status AS "responseStatus",
              deliveries.delivered_at AS "deliveredAt"
       FROM settlement_callback_deliveries deliveries
       JOIN settlement_execution_events events ON events.event_id = deliveries.event_id
       WHERE deliveries.handoff_id = ANY($1::text[])
       ORDER BY deliveries.created_at`,
      [handoffIds],
    );
    return {
      handoffs: handoffs.rows,
      callbackDeliveries: callbackDeliveries.rows,
    };
  } finally {
    await client.end();
  }
}

async function waitForGatewayCallbacks(cotselEnv, handoffIds, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await readGatewayEvidence(cotselEnv, handoffIds);
    const hasPending = latest.callbackDeliveries.some((delivery) =>
      ['pending', 'delivering'].includes(delivery.status),
    );
    if (latest.callbackDeliveries.length > 0 && !hasPending) {
      return latest;
    }
    await wait(2000);
  }
  return latest;
}

async function main() {
  const cotselEnv = parseEnvFile(path.join(COTSEL_ROOT, '.env.staging-e2e-real'));
  const backendEnv = parseEnvFile(path.join(BACKEND_ROOT, '.env'));
  const apiKeys = JSON.parse(requireEnv(cotselEnv, 'GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON'));
  const serviceKey = apiKeys.find((key) => key.active !== false);
  if (!serviceKey) throw new Error('No active gateway settlement service API key configured');

  const rpcUrl = requireEnv(cotselEnv, 'GATEWAY_RPC_URL');
  const chainId = Number(requireEnv(cotselEnv, 'GATEWAY_CHAIN_ID'));
  const gatewayBaseUrl = `http://127.0.0.1:${requireEnv(cotselEnv, 'GATEWAY_PORT')}/api/dashboard-gateway/v1`;
  const escrowAddress = requireEnv(cotselEnv, 'GATEWAY_ESCROW_ADDRESS');
  const usdcAddress = requireEnv(cotselEnv, 'GATEWAY_USDC_ADDRESS');
  const buyerKey = requireEnv(process.env, 'BUYER_PRIVATE_KEY');
  const serviceKeyPrivate = requireEnv(cotselEnv, 'GATEWAY_GASLESS_EXECUTOR_PRIVATE_KEY');
  const nativeTokenUsdPriceUsd = requireNumberEnv(cotselEnv, 'PILOT_NATIVE_TOKEN_USD_PRICE_USD');

  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const buyer = new Wallet(buyerKey, provider);
  const service = new Wallet(serviceKeyPrivate, provider);
  const escrow = new Contract(escrowAddress, ESCROW_ABI, service);
  const usdc = new Contract(usdcAddress, ERC20_ABI, provider);

  const wallets = {
    buyer: await buyer.getAddress(),
    supplier: requireEnv(cotselEnv, 'SUPPLIER_WALLET_ADDRESS'),
    service: await service.getAddress(),
  };
  const expectedWallets = {
    buyer: requireEnv(cotselEnv, 'BUYER_WALLET_ADDRESS'),
    supplier: requireEnv(cotselEnv, 'SUPPLIER_WALLET_ADDRESS'),
    service: requireEnv(cotselEnv, 'SERVICE_WALLET_ADDRESS'),
  };
  for (const role of ['buyer', 'service']) {
    if (wallets[role].toLowerCase() !== expectedWallets[role].toLowerCase()) {
      throw new Error(`${role} key derives to ${wallets[role]}, expected ${expectedWallets[role]}`);
    }
  }
  if (wallets.supplier.toLowerCase() !== expectedWallets.supplier.toLowerCase()) {
    throw new Error(`supplier wallet is ${wallets.supplier}, expected ${expectedWallets.supplier}`);
  }
  const disputeApprovers = await loadDisputeApprovers({ provider, escrow, cotselEnv, wallets });

  const decimals = await usdc.decimals();
  const amount = (value) => parseUnits(value, decimals);
  const amounts = {
    total: amount('10'),
    logistics: amount('1'),
    platformFees: amount('4'),
    supplierFirstTranche: amount('2'),
    supplierSecondTranche: amount('3'),
    ricardianHash: keccak256(toUtf8Bytes(`${WINDOW_ID}:${Date.now()}:ricardian`)),
  };
  const observedAmounts = {
    observedSupplierPayoutUsd: Number(formatUnits(amounts.supplierFirstTranche, decimals)),
    observedTreasuryClaimableUsd: Number(
      formatUnits(amounts.logistics + amounts.platformFees, decimals),
    ),
    observedBuyerRefundUsd: Number(formatUnits(amounts.supplierSecondTranche, decimals)),
  };
  const requestId = `${WINDOW_ID.toLowerCase()}-${Date.now()}`;
  const sponsorshipPlatformHandoffId = `gasless-sponsorship:${requestId}`;
  const tradeCounterBefore = await escrow.tradeCounter();
  const backendSeed = await seedBackend({
    backendEnv,
    requestId,
    tradeRef: String(tradeCounterBefore),
    amounts,
    wallets,
    escrowAddress,
    usdcAddress,
    chainId,
  });

  const balancesBefore = await readBalances({ provider, usdc, wallets, escrowAddress, decimals });
  const treasuryClaimableBefore = await escrow.claimableUsdc(wallets.service);
  if (balancesBefore.buyer.usdcBaseUnits < amounts.total) {
    throw new Error('Buyer does not have enough Base Sepolia USDC for the pilot proof');
  }

  const handoffCreate = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: '/settlement/handoffs',
    idempotencyKey: `handoff-create-${requestId}`,
    body: {
      platformId: 'agroasys-backend',
      platformHandoffId: sponsorshipPlatformHandoffId,
      tradeId: `PILOT-${requestId}`,
      phase: 'create_trade',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: 10,
      assetSymbol: 'USDC',
      assetAmount: 10,
      ricardianHash: amounts.ricardianHash,
      externalReference: requestId,
      metadata: {
        windowId: WINDOW_ID,
        nativeTokenSymbol: 'ETH',
        nativeTokenUsdPriceUsd,
      },
    },
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const deadline = String(nowSeconds + 600);
  const createNonce = (await escrow.getAuthorizationNonce(wallets.buyer)).toString();
  const createAuthorization = await buyer.signTypedData(
    { name: 'AgroasysEscrow', version: '1', chainId, verifyingContract: escrowAddress },
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
    {
      buyer: wallets.buyer,
      supplier: wallets.supplier,
      totalAmount: amounts.total,
      logisticsAmount: amounts.logistics,
      platformFeesAmount: amounts.platformFees,
      supplierFirstTranche: amounts.supplierFirstTranche,
      supplierSecondTranche: amounts.supplierSecondTranche,
      ricardianHash: amounts.ricardianHash,
      nonce: createNonce,
      deadline,
    },
  );
  const usdcNonce = `0x${crypto.randomBytes(32).toString('hex')}`;
  const usdcSignature = Signature.from(
    await buyer.signTypedData(
      {
        name: await usdc.name(),
        version: await usdc.version(),
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
      {
        from: wallets.buyer,
        to: escrowAddress,
        value: amounts.total,
        validAfter: 0,
        validBefore: deadline,
        nonce: usdcNonce,
      },
    ),
  );
  const createPayload = {
    action: 'create_trade',
    handoffId: handoffCreate.data.handoffId,
    chainId,
    contractAddress: escrowAddress,
    expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    buyerAddress: wallets.buyer,
    supplierAddress: wallets.supplier,
    totalAmount: amounts.total.toString(),
    logisticsAmount: amounts.logistics.toString(),
    platformFeesAmount: amounts.platformFees.toString(),
    supplierFirstTranche: amounts.supplierFirstTranche.toString(),
    supplierSecondTranche: amounts.supplierSecondTranche.toString(),
    ricardianHash: amounts.ricardianHash,
    buyerAuthorization: {
      nonce: createNonce,
      deadline,
      signature: createAuthorization,
    },
    usdcAuthorization: {
      from: wallets.buyer,
      to: escrowAddress,
      value: amounts.total.toString(),
      validAfter: '0',
      validBefore: deadline,
      nonce: usdcNonce,
      v: usdcSignature.v,
      r: usdcSignature.r,
      s: usdcSignature.s,
    },
  };
  const failureModeEvidence = {
    relayerOutageOrDisabled: readOperatorEvidencePacket(
      cotselEnv,
      'PILOT_RELAYER_OUTAGE_EVIDENCE_REF',
      'relayer_outage_or_disabled',
    ),
    fallbackUx: readOperatorEvidencePacket(
      cotselEnv,
      'PILOT_FALLBACK_UX_EVIDENCE_REF',
      'fallback_ux',
    ),
    operatorFailureRehearsal: readOperatorEvidencePacket(
      cotselEnv,
      'PILOT_FAILURE_REHEARSAL_EVIDENCE_REF',
      'operator_failure_rehearsal',
    ),
  };
  const expiredCreatePayload = {
    ...createPayload,
    buyerAuthorization: {
      ...createPayload.buyerAuthorization,
      deadline: String(nowSeconds - 60),
    },
  };
  const tradeCounterBeforeExpiredCheck = await escrow.tradeCounter();
  const expiredAuthorization = await expectGatewayFailure({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: '/settlement/gasless-executions/create-trade',
    idempotencyKey: `gasless-create-expired-${requestId}`,
    body: { ...expiredCreatePayload, payloadHash: payloadHash(expiredCreatePayload) },
    expectedStatus: 400,
    expectedMessageIncludes: 'buyerAuthorization.deadline has expired',
  });
  const tradeCounterAfterExpiredCheck = await escrow.tradeCounter();
  failureModeEvidence.expiredAuthorization = {
    ...expiredAuthorization,
    tradeCounterBefore: tradeCounterBeforeExpiredCheck.toString(),
    tradeCounterAfter: tradeCounterAfterExpiredCheck.toString(),
    noTradeCreated: tradeCounterAfterExpiredCheck === tradeCounterBeforeExpiredCheck,
    passed:
      expiredAuthorization.passed &&
      tradeCounterAfterExpiredCheck === tradeCounterBeforeExpiredCheck,
  };
  const createResult = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: '/settlement/gasless-executions/create-trade',
    idempotencyKey: `gasless-create-${requestId}`,
    body: { ...createPayload, payloadHash: payloadHash(createPayload) },
  });
  const createReplayResult = await waitForIdempotentReplay(
    {
      baseUrl: gatewayBaseUrl,
      apiKey: serviceKey.id,
      apiSecret: serviceKey.secret,
      route: '/settlement/gasless-executions/create-trade',
      idempotencyKey: `gasless-create-${requestId}`,
      body: { ...createPayload, payloadHash: payloadHash(createPayload) },
    },
    8,
    250,
  );
  const tradeCounterAfterReplay = await escrow.tradeCounter();
  failureModeEvidence.idempotentReplay = {
    route: '/settlement/gasless-executions/create-trade',
    idempotencyKey: `gasless-create-${requestId}`,
    expectedStatus: 202,
    actualStatus: createReplayResult.status,
    attempts: createReplayResult.attempts,
    replayHeader: createReplayResult.headers['x-idempotent-replay'] ?? null,
    firstTxHash: createResult.data.txHash,
    replayTxHash: createReplayResult.payload?.data?.txHash ?? null,
    tradeCounterBefore: tradeCounterBefore.toString(),
    tradeCounterAfterReplay: tradeCounterAfterReplay.toString(),
    noDuplicateTradeCreated: tradeCounterAfterReplay === tradeCounterBefore + 1n,
    passed:
      createReplayResult.status === 202 &&
      createReplayResult.headers['x-idempotent-replay'] === 'true' &&
      createReplayResult.payload?.data?.txHash === createResult.data.txHash &&
      tradeCounterAfterReplay === tradeCounterBefore + 1n,
  };
  const tradeId = tradeCounterBefore.toString();
  const tradeAfterCreate = await escrow.trades(tradeId);

  const stage1Receipt = await waitForTx(await escrow.releaseFundsStage1(tradeId));
  const arrivalReceipt = await waitForTx(await escrow.confirmArrival(tradeId));

  const backendRefund = await seedBackendRefundHandoff({
    backendEnv,
    orderId: backendSeed.orderId,
    tradeId,
    amounts,
  });

  const handoffRefund = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: '/settlement/handoffs',
    idempotencyKey: `handoff-refund-${requestId}`,
    body: {
      platformId: 'agroasys-backend',
      platformHandoffId: String(backendRefund.handoffId),
      tradeId,
      phase: 'dispute_resolved_final_release',
      settlementChannel: 'cotsel_escrow',
      displayCurrency: 'USD',
      displayAmount: Number(formatUnits(amounts.supplierSecondTranche, decimals)),
      assetSymbol: 'USDC',
      assetAmount: Number(formatUnits(amounts.supplierSecondTranche, decimals)),
      ricardianHash: amounts.ricardianHash,
      externalReference: requestId,
      metadata: {
        windowId: WINDOW_ID,
        nativeTokenSymbol: 'ETH',
        nativeTokenUsdPriceUsd,
        ...observedAmounts,
      },
    },
  });
  await updateBackendRefundHandoffRemoteId({
    backendEnv,
    handoffId: backendRefund.handoffId,
    remoteHandoffId: handoffRefund.data.handoffId,
  });

  const disputeNonce = (await escrow.getAuthorizationNonce(wallets.buyer)).toString();
  const disputeDeadline = String(Math.floor(Date.now() / 1000) + 600);
  const disputeSignature = await buyer.signTypedData(
    { name: 'AgroasysEscrow', version: '1', chainId, verifyingContract: escrowAddress },
    {
      UserActionAuthorization: [
        { name: 'user', type: 'address' },
        { name: 'action', type: 'uint8' },
        { name: 'tradeId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    {
      user: wallets.buyer,
      action: 1,
      tradeId,
      nonce: disputeNonce,
      deadline: disputeDeadline,
    },
  );
  const disputePayload = {
    action: 'open_dispute',
    handoffId: handoffRefund.data.handoffId,
    chainId,
    contractAddress: escrowAddress,
    expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    userAddress: wallets.buyer,
    tradeId,
    userAuthorization: {
      nonce: disputeNonce,
      deadline: disputeDeadline,
      signature: disputeSignature,
    },
  };
  const disputeResult = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: '/settlement/gasless-executions/user-action',
    idempotencyKey: `gasless-dispute-${requestId}`,
    body: { ...disputePayload, payloadHash: payloadHash(disputePayload) },
  });

  const proposalId = (await escrow.disputeCounter()).toString();
  const proposalReceipt = await waitForTx(
    await escrow.connect(disputeApprovers.wallets[0]).proposeDisputeSolution(tradeId, 0),
  );
  const refundReceipt = await waitForTx(
    await escrow.connect(disputeApprovers.wallets[1]).approveDisputeSolution(proposalId),
  );

  const refundReconciledResult = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    route: `/settlement/handoffs/${encodeURIComponent(handoffRefund.data.handoffId)}/execution-events`,
    idempotencyKey: `refund-reconciled-${requestId}`,
    body: {
      eventType: 'reconciled',
      executionStatus: 'confirmed',
      reconciliationStatus: 'matched',
      providerStatus: 'buyer_refund_transferred',
      txHash: refundReceipt.txHash,
      detail: 'Buyer refund was transferred directly from escrow after dispute approval.',
      observedAt: new Date().toISOString(),
      metadata: {
        action: 'buyer_refund_direct_transfer',
        tradeId,
        nativeTokenSymbol: 'ETH',
        nativeTokenUsdPriceUsd,
        ...observedAmounts,
      },
    },
  });

  const gatewayEvidence = await waitForGatewayCallbacks(cotselEnv, [
    handoffCreate.data.handoffId,
    handoffRefund.data.handoffId,
  ]);
  const balancesAfter = await readBalances({ provider, usdc, wallets, escrowAddress, decimals });
  const backendEvidence = await readBackendEvidence(backendEnv, requestId, backendRefund.handoffId);
  const gatewayEvents = await gatewayJson({
    baseUrl: gatewayBaseUrl,
    apiKey: serviceKey.id,
    apiSecret: serviceKey.secret,
    method: 'GET',
    route: `/settlement/handoffs/${encodeURIComponent(handoffRefund.data.handoffId)}/execution-events`,
    body: null,
  });
  const finalTrade = await escrow.trades(tradeId);
  const treasuryClaimable = await escrow.claimableUsdc(wallets.service);
  const currentRunDeltas = {
    buyerUsdc: balancesAfter.buyer.usdcBaseUnits - balancesBefore.buyer.usdcBaseUnits,
    supplierUsdc: balancesAfter.supplier.usdcBaseUnits - balancesBefore.supplier.usdcBaseUnits,
    escrowUsdc: balancesAfter.escrow.usdcBaseUnits - balancesBefore.escrow.usdcBaseUnits,
    serviceEthWei: balancesAfter.service.ethWei - balancesBefore.service.ethWei,
    treasuryClaimable: treasuryClaimable - treasuryClaimableBefore,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const report = {
    windowId: WINDOW_ID,
    generatedAt: new Date().toISOString(),
    chainId,
    escrowAddress,
    usdcAddress,
    wallets,
    disputeApprovers: {
      requiredApprovals: disputeApprovers.requiredApprovals,
      addresses: disputeApprovers.addresses,
      userWalletsAreAdmins: false,
    },
    nativeTokenUsdPriceUsd,
    requestId,
    backendSeed,
    backendRefund,
    handoffs: {
      createInitial: handoffCreate.data,
      createConfirmed: createResult.data.handoff,
      refundInitial: handoffRefund.data,
      refundAfterGaslessDispute: disputeResult.data.handoff,
      refundReconciled: refundReconciledResult.data.handoff,
    },
    trade: {
      tradeId,
      statusAfterCreate: tradeAfterCreate.status.toString(),
      finalStatus: finalTrade.status.toString(),
      totalAmount: amounts.total.toString(),
      logisticsAmount: amounts.logistics.toString(),
      platformFeesAmount: amounts.platformFees.toString(),
      supplierFirstTranche: amounts.supplierFirstTranche.toString(),
      supplierSecondTranche: amounts.supplierSecondTranche.toString(),
      treasuryClaimable: treasuryClaimable.toString(),
      treasuryClaimableBefore: treasuryClaimableBefore.toString(),
      treasuryClaimableDelta: currentRunDeltas.treasuryClaimable.toString(),
    },
    currentRunEvidence: {
      balanceDeltas: {
        buyerUsdc: currentRunDeltas.buyerUsdc.toString(),
        supplierUsdc: currentRunDeltas.supplierUsdc.toString(),
        escrowUsdc: currentRunDeltas.escrowUsdc.toString(),
        serviceEthWei: currentRunDeltas.serviceEthWei.toString(),
      },
      nonRefundableFeesAddedToTreasury: currentRunDeltas.treasuryClaimable.toString(),
      expectedNonRefundableFees: (amounts.logistics + amounts.platformFees).toString(),
      note: 'Deltas are scoped to this proof run. treasuryClaimable is cumulative for the deployed escrow.',
    },
    transactions: {
      createTradeGasless: createResult.data.txHash,
      stage1Release: stage1Receipt.txHash,
      confirmArrival: arrivalReceipt.txHash,
      openDisputeGasless: disputeResult.data.txHash,
      proposeRefund: proposalReceipt.txHash,
      approveRefund: refundReceipt.txHash,
    },
    failureModeEvidence,
    dispute: {
      proposalId,
    },
    balances: {
      before: serializeBalances(balancesBefore),
      after: serializeBalances(balancesAfter),
    },
    gateway: {
      createResult: createResult.data,
      disputeResult: disputeResult.data,
      refundEvents: gatewayEvents.data,
    },
    gatewayEvidence,
    backendEvidence,
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, bigintReplacer, 2)}\n`);
  console.log(`live proof written: ${REPORT_PATH}`);
  console.log(
    JSON.stringify(
      {
        tradeId,
        txs: report.transactions,
        currentRunEvidence: report.currentRunEvidence,
        failureModeEvidence: report.failureModeEvidence,
        backendAccountingEntries: backendEvidence.accounting.length,
        backendRefundEvents: backendEvidence.refundEvents.length,
      },
      null,
      2,
    ),
  );
}

async function readBalances({ provider, usdc, wallets, escrowAddress, decimals }) {
  const entries = await Promise.all(
    Object.entries({ ...wallets, escrow: escrowAddress }).map(async ([name, address]) => {
      const [eth, usdcBalance] = await Promise.all([
        provider.getBalance(address),
        usdc.balanceOf(address),
      ]);
      return [
        name,
        {
          address,
          ethWei: eth,
          eth: formatUnits(eth, 18),
          usdcBaseUnits: usdcBalance,
          usdc: formatUnits(usdcBalance, decimals),
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function serializeBalances(balances) {
  return Object.fromEntries(
    Object.entries(balances).map(([name, value]) => [
      name,
      {
        address: value.address,
        ethWei: value.ethWei.toString(),
        eth: value.eth,
        usdcBaseUnits: value.usdcBaseUnits.toString(),
        usdc: value.usdc,
      },
    ]),
  );
}

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
