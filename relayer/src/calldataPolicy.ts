import { getAddress, Interface, isAddress, Signature, verifyTypedData, ZeroAddress } from 'ethers';
import { AgroasysEscrow__factory, type ManagedSignerPolicyContext } from '@agroasys/sdk';
import type { RelayerConfig } from './config';
import { RelayerError } from './errors';
import type { RelayerOperation } from './signingPolicy';

const escrowInterface = new Interface(AgroasysEscrow__factory.abi);
const usdcInterface = new Interface([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);

const OPERATION_FUNCTIONS: Record<RelayerOperation, string> = {
  create_trade: 'createTradeWithAuthorization',
  open_dispute: 'openDisputeWithAuthorization',
  cancel_locked_timeout: 'cancelLockedTradeAfterTimeoutWithAuthorization',
  refund_in_transit_timeout: 'refundInTransitAfterTimeoutWithAuthorization',
  finalize_after_dispute_window: 'finalizeAfterDisputeWindowWithAuthorization',
  finalize_after_inspection_acceptance: 'finalizeAfterInspectionAcceptanceWithAuthorization',
  wallet_usdc_transfer: 'transferWithAuthorization',
};

const USER_ACTION_IDS: Partial<Record<RelayerOperation, number>> = {
  open_dispute: 1,
  cancel_locked_timeout: 2,
  refund_in_transit_timeout: 3,
  finalize_after_dispute_window: 4,
  finalize_after_inspection_acceptance: 5,
};

function reject(message: string): never {
  throw new RelayerError(403, 'SIGNING_POLICY_REJECTED', message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => value[key] === undefined)
  ) {
    reject(`${field} fields do not match the approved policy shape`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    reject(`${field} must be a non-empty canonical string`);
  }
  return value;
}

function uint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    reject(`${field} must be an unsigned integer string`);
  }
  return BigInt(value).toString();
}

function address(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value) || value === ZeroAddress) {
    reject(`${field} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

function bytes32(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    reject(`${field} must be a 32-byte hex value`);
  }
  return value.toLowerCase();
}

function same(actual: unknown, expected: string, field: string): void {
  if (BigInt(actual as bigint).toString() !== expected) reject(`${field} does not match policy`);
}

function verifyActor(
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  types: Record<string, Array<{ name: string; type: string }>>,
  values: Record<string, unknown>,
  signature: string,
  expectedActor: string,
): void {
  try {
    if (getAddress(verifyTypedData(domain, types, values, signature)) !== expectedActor) {
      reject('calldata authorization signer does not match policy actor');
    }
  } catch (error) {
    if (error instanceof RelayerError) throw error;
    reject('calldata authorization signature is invalid');
  }
}

function validateCreateTrade(
  args: readonly unknown[],
  context: Record<string, unknown>,
  config: RelayerConfig,
  nowSeconds: bigint,
): ManagedSignerPolicyContext {
  const fields = [
    'kind',
    'resourceId',
    'actorAddress',
    'supplierAddress',
    'authorizationNonce',
    'authorizationDeadline',
    'usdcAuthorizationNonce',
    'usdcValidAfter',
    'usdcValidBefore',
  ];
  exactKeys(context, fields, 'policyContext');
  if (context.kind !== 'create_trade') reject('policyContext kind does not match operation');
  const actorAddress = address(context.actorAddress, 'policyContext.actorAddress');
  const supplierAddress = address(context.supplierAddress, 'policyContext.supplierAddress');
  const authorizationNonce = uint(context.authorizationNonce, 'policyContext.authorizationNonce');
  const authorizationDeadline = uint(
    context.authorizationDeadline,
    'policyContext.authorizationDeadline',
  );
  const usdcAuthorizationNonce = bytes32(
    context.usdcAuthorizationNonce,
    'policyContext.usdcAuthorizationNonce',
  );
  const usdcValidAfter = uint(context.usdcValidAfter, 'policyContext.usdcValidAfter');
  const usdcValidBefore = uint(context.usdcValidBefore, 'policyContext.usdcValidBefore');
  if (getAddress(String(args[0])) !== actorAddress) reject('calldata buyer does not match policy');
  if (getAddress(String(args[1])) !== supplierAddress)
    reject('calldata supplier does not match policy');
  same(args[8], authorizationNonce, 'calldata authorization nonce');
  same(args[9], authorizationDeadline, 'calldata authorization deadline');
  const usdcAuthorization = args[11] as readonly unknown[];
  if (!usdcAuthorization || usdcAuthorization.length !== 6) {
    reject('calldata USDC authorization has an unsupported structure');
  }
  same(usdcAuthorization[0], usdcValidAfter, 'calldata USDC validAfter');
  same(usdcAuthorization[1], usdcValidBefore, 'calldata USDC validBefore');
  if (String(usdcAuthorization[2]).toLowerCase() !== usdcAuthorizationNonce) {
    reject('calldata USDC nonce does not match policy');
  }
  if (BigInt(authorizationDeadline) < nowSeconds || BigInt(usdcValidBefore) <= nowSeconds) {
    reject('calldata authorization is expired');
  }
  if (BigInt(usdcValidAfter) > nowSeconds) reject('calldata USDC authorization is not yet valid');
  verifyActor(
    {
      name: 'AgroasysEscrow',
      version: '1',
      chainId: config.chainId,
      verifyingContract: config.escrowAddress,
    },
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
      buyer: args[0],
      supplier: args[1],
      totalAmount: args[2],
      logisticsAmount: args[3],
      platformFeesAmount: args[4],
      supplierFirstTranche: args[5],
      supplierSecondTranche: args[6],
      ricardianHash: args[7],
      nonce: args[8],
      deadline: args[9],
    },
    String(args[10]),
    actorAddress,
  );
  return {
    kind: 'create_trade',
    resourceId: text(context.resourceId, 'policyContext.resourceId'),
    actorAddress,
    supplierAddress,
    authorizationNonce,
    authorizationDeadline,
    usdcAuthorizationNonce,
    usdcValidAfter,
    usdcValidBefore,
  };
}

function validateUserAction(
  operation: RelayerOperation,
  args: readonly unknown[],
  context: Record<string, unknown>,
  config: RelayerConfig,
  nowSeconds: bigint,
): ManagedSignerPolicyContext {
  const fields = [
    'kind',
    'resourceId',
    'actorAddress',
    'tradeId',
    'authorizationNonce',
    'authorizationDeadline',
  ];
  exactKeys(context, fields, 'policyContext');
  if (context.kind !== 'user_action') reject('policyContext kind does not match operation');
  const actorAddress = address(context.actorAddress, 'policyContext.actorAddress');
  const tradeId = uint(context.tradeId, 'policyContext.tradeId');
  const authorizationNonce = uint(context.authorizationNonce, 'policyContext.authorizationNonce');
  const authorizationDeadline = uint(
    context.authorizationDeadline,
    'policyContext.authorizationDeadline',
  );
  same(args[0], tradeId, 'calldata trade ID');
  same(args[1], authorizationNonce, 'calldata authorization nonce');
  same(args[2], authorizationDeadline, 'calldata authorization deadline');
  if (BigInt(authorizationDeadline) < nowSeconds) reject('calldata authorization is expired');
  verifyActor(
    {
      name: 'AgroasysEscrow',
      version: '1',
      chainId: config.chainId,
      verifyingContract: config.escrowAddress,
    },
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
      user: actorAddress,
      action: USER_ACTION_IDS[operation],
      tradeId: args[0],
      nonce: args[1],
      deadline: args[2],
    },
    String(args[3]),
    actorAddress,
  );
  return {
    kind: 'user_action',
    resourceId: text(context.resourceId, 'policyContext.resourceId'),
    actorAddress,
    tradeId,
    authorizationNonce,
    authorizationDeadline,
  };
}

function validateWalletTransfer(
  args: readonly unknown[],
  context: Record<string, unknown>,
  config: RelayerConfig,
  nowSeconds: bigint,
): ManagedSignerPolicyContext {
  const fields = [
    'kind',
    'resourceId',
    'actorAddress',
    'recipientAddress',
    'amount',
    'validAfter',
    'validBefore',
    'authorizationNonce',
    'authorizationDomainName',
  ];
  exactKeys(context, fields, 'policyContext');
  if (context.kind !== 'wallet_usdc_transfer')
    reject('policyContext kind does not match operation');
  const actorAddress = address(context.actorAddress, 'policyContext.actorAddress');
  const recipientAddress = address(context.recipientAddress, 'policyContext.recipientAddress');
  const amount = uint(context.amount, 'policyContext.amount');
  const validAfter = uint(context.validAfter, 'policyContext.validAfter');
  const validBefore = uint(context.validBefore, 'policyContext.validBefore');
  const authorizationNonce = bytes32(
    context.authorizationNonce,
    'policyContext.authorizationNonce',
  );
  const authorizationDomainName = text(
    context.authorizationDomainName,
    'policyContext.authorizationDomainName',
  );
  if (getAddress(String(args[0])) !== actorAddress) reject('calldata sender does not match policy');
  if (getAddress(String(args[1])) !== recipientAddress)
    reject('calldata recipient does not match policy');
  same(args[2], amount, 'calldata transfer amount');
  same(args[3], validAfter, 'calldata authorization validAfter');
  same(args[4], validBefore, 'calldata authorization validBefore');
  if (String(args[5]).toLowerCase() !== authorizationNonce)
    reject('calldata authorization nonce does not match policy');
  if (BigInt(validAfter) > nowSeconds || BigInt(validBefore) <= nowSeconds)
    reject('calldata authorization is not currently valid');
  const signature = Signature.from({
    v: Number(args[6]),
    r: String(args[7]),
    s: String(args[8]),
  }).serialized;
  verifyActor(
    {
      name: authorizationDomainName,
      version: '2',
      chainId: config.chainId,
      verifyingContract: config.usdcAddress,
    },
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    {
      from: args[0],
      to: args[1],
      value: args[2],
      validAfter: args[3],
      validBefore: args[4],
      nonce: args[5],
    },
    signature,
    actorAddress,
  );
  return {
    kind: 'wallet_usdc_transfer',
    resourceId: text(context.resourceId, 'policyContext.resourceId'),
    actorAddress,
    recipientAddress,
    amount,
    validAfter,
    validBefore,
    authorizationNonce,
    authorizationDomainName,
  };
}

export function validateCalldataPolicy(
  operation: RelayerOperation,
  data: string,
  policyContext: unknown,
  config: RelayerConfig,
  now = new Date(),
): ManagedSignerPolicyContext {
  const contractInterface = operation === 'wallet_usdc_transfer' ? usdcInterface : escrowInterface;
  let parsed;
  try {
    parsed = contractInterface.parseTransaction({ data });
  } catch {
    reject('transaction calldata is malformed or unsupported');
  }
  const expectedFunction = OPERATION_FUNCTIONS[operation];
  if (!parsed || parsed.name !== expectedFunction)
    reject('transaction calldata does not match operation');
  if (
    contractInterface.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !==
    data.toLowerCase()
  ) {
    reject('transaction calldata is not the canonical supported ABI encoding');
  }
  const context = record(policyContext, 'policyContext');
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (operation === 'create_trade')
    return validateCreateTrade(parsed.args, context, config, nowSeconds);
  if (operation === 'wallet_usdc_transfer')
    return validateWalletTransfer(parsed.args, context, config, nowSeconds);
  return validateUserAction(operation, parsed.args, context, config, nowSeconds);
}
