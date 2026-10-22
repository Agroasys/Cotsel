/** SPDX-License-Identifier: Apache-2.0 */
// Test-only IPC contract. Never exported by production packages.
import { isAbsolute } from 'path';
import {
  parseSettlementUserActionBinding,
  type SettlementUserActionBinding,
} from '../../src/core/settlementUserActionBinding';
import type { GaslessUserActionExecutionInput } from '../../src/core/gaslessExecutionTypes';
import {
  USER_ACTION_RETIREMENT_PATH,
  type UserActionRetirementTransportConfig,
} from '../../src/core/userActionEngine/retirementTransport';
import type { VerifyUserActionRetirement } from '../../src/core/userActionEngine/retirement';

export const PAIRED_PROTOCOL = 'cotsel.paired-lifecycle-fixture.v1' as const;
export type PairedAcceptedBody = Omit<
  GaslessUserActionExecutionInput,
  | 'requestId'
  | 'sourceApiKeyId'
  | 'actionPackageId'
  | 'sourceOperationId'
  | 'approvalScopeFingerprint'
> &
  Required<
    Pick<
      GaslessUserActionExecutionInput,
      'actionPackageId' | 'sourceOperationId' | 'approvalScopeFingerprint'
    >
  >;
export interface PairedFundingWitness {
  chainId: string;
  receipt: {
    hash: string;
    to: string;
    status: 1;
    blockNumber: number;
    blockHash: string;
    logs: Array<{ address: string; topics: string[]; data: string; index: number }>;
  };
  blocks: Array<{ number: number; hash: string }>;
  finalizedBlockNumber: number;
}
interface Envelope {
  protocol: typeof PAIRED_PROTOCOL;
  commandId: string;
}
export interface PairedStart extends Envelope {
  command: 'start';
  custodyMode: 'raw' | 'kms';
  serviceAuth: { apiKeyId: string; secret: string };
  tls: { keyPath: string; certificatePath: string };
  executionBinding: SettlementUserActionBinding;
  fundingWitnesses: [PairedFundingWitness, PairedFundingWitness];
  barrier: 'claimed' | 'signing' | null;
  localRpcUrls?: [string, string];
}
export type PairedCommand =
  | PairedStart
  | (Envelope &
      (
        | { command: 'pinAcceptedBody'; acceptedBody: PairedAcceptedBody }
        | { command: 'verifyRetirement'; transport: UserActionRetirementTransportConfig }
        | { command: 'releaseBarrier' | 'expirePreSignLeases' | 'inspectCounters' | 'shutdown' }
      ));
export interface PairedCounters {
  acceptedRequests: number;
  executionAttempts: number;
  outcomes: number;
  signerInvocations: number;
  broadcastCalls: number;
  fundingReads: number;
  transactionHashes: string[];
}
export interface PairedEvent {
  protocol: typeof PAIRED_PROTOCOL;
  commandId?: string;
  event: 'ready' | 'result' | 'barrierReached' | 'executionFinished' | 'error';
  command?: PairedCommand['command'];
  counters?: PairedCounters;
  baseUrl?: string;
  productionBaseUrl?: string;
  ownerServiceId?: string;
  databaseName?: string;
  runtimeRole?: string;
  sourceOperationId?: string;
  requestId?: string;
  requestFingerprint?: string;
  stage?: 'claimed' | 'signing';
  requestLeaseRows?: number;
  httpLeaseRows?: number;
  executionResult?: 'resolved' | 'rejected';
  retirement?: Awaited<ReturnType<VerifyUserActionRetirement>>;
  code?: 'fixture_invalid' | 'fixture_failed';
}
function invalid(): never {
  throw new Error('Invalid paired fixture protocol');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function height(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}
function address(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
}
function witness(value: unknown): void {
  const v = object(value, ['chainId', 'receipt', 'blocks', 'finalizedBlockNumber']);
  if (
    typeof v.chainId !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(v.chainId) ||
    !height(v.finalizedBlockNumber)
  )
    invalid();
  const r = object(v.receipt, ['hash', 'to', 'status', 'blockNumber', 'blockHash', 'logs']);
  if (
    !hash(r.hash) ||
    !address(r.to) ||
    r.status !== 1 ||
    !height(r.blockNumber) ||
    !hash(r.blockHash) ||
    !Array.isArray(r.logs) ||
    r.logs.length < 1 ||
    r.logs.length > 32
  )
    invalid();
  const indexes = new Set<number>();
  for (const log of r.logs) {
    const l = object(log, ['address', 'topics', 'data', 'index']);
    if (
      !address(l.address) ||
      !Array.isArray(l.topics) ||
      l.topics.length > 4 ||
      !l.topics.every(hash) ||
      typeof l.data !== 'string' ||
      !/^0x(?:[0-9a-f]{2}){0,4096}$/.test(l.data) ||
      !height(l.index) ||
      indexes.has(l.index)
    )
      invalid();
    indexes.add(l.index);
  }
  if (!Array.isArray(v.blocks) || v.blocks.length < 1 || v.blocks.length > 8) invalid();
  const heights = new Set<number>();
  for (const block of v.blocks) {
    const b = object(block, ['number', 'hash']);
    if (!height(b.number) || !hash(b.hash) || heights.has(b.number)) invalid();
    heights.add(b.number);
  }
  if (
    !heights.has(v.finalizedBlockNumber) ||
    !heights.has(r.blockNumber) ||
    v.finalizedBlockNumber < r.blockNumber
  )
    invalid();
}
export function parsePairedCommand(value: unknown): PairedCommand {
  const raw = value as Record<string, unknown> | null;
  if (
    !raw ||
    raw.protocol !== PAIRED_PROTOCOL ||
    typeof raw.commandId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.commandId)
  )
    invalid();
  if (raw.command === 'start') {
    const v = object(value, [
      'protocol',
      'commandId',
      'command',
      'custodyMode',
      'serviceAuth',
      'tls',
      'executionBinding',
      'fundingWitnesses',
      'barrier',
      ...(raw.localRpcUrls === undefined ? [] : ['localRpcUrls']),
    ]);
    if (v.localRpcUrls !== undefined) {
      if (!Array.isArray(v.localRpcUrls) || v.localRpcUrls.length !== 2) invalid();
      for (const rawUrl of v.localRpcUrls) {
        if (typeof rawUrl !== 'string') invalid();
        const url = new URL(rawUrl);
        if (
          url.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          invalid();
      }
    }
    const auth = object(v.serviceAuth, ['apiKeyId', 'secret']);
    const tls = object(v.tls, ['keyPath', 'certificatePath']);
    if (
      !text(auth.apiKeyId, 128) ||
      !/^\S+$/.test(auth.apiKeyId) ||
      !text(auth.secret, 256) ||
      !text(tls.keyPath, 4096) ||
      !isAbsolute(tls.keyPath) ||
      !text(tls.certificatePath, 4096) ||
      !isAbsolute(tls.certificatePath) ||
      !['raw', 'kms'].includes(v.custodyMode as string) ||
      ![null, 'claimed', 'signing'].includes(v.barrier as null)
    )
      invalid();
    const b = parseSettlementUserActionBinding(v.executionBinding, auth.apiKeyId);
    if (
      ![
        'finalize_after_inspection_acceptance',
        'cancel_locked_timeout',
        'refund_in_transit_timeout',
      ].includes(b.action)
    )
      invalid();
    if (!Array.isArray(v.fundingWitnesses) || v.fundingWitnesses.length !== 2) invalid();
    v.fundingWitnesses.forEach(witness);
  } else if (raw.command === 'pinAcceptedBody')
    object(value, ['protocol', 'commandId', 'command', 'acceptedBody']);
  else if (raw.command === 'verifyRetirement') {
    const v = object(value, ['protocol', 'commandId', 'command', 'transport']);
    const transport = object(v.transport, [
      'url',
      'owningServiceId',
      'apiKey',
      'apiSecret',
      'timeoutMs',
    ]);
    if (
      !text(transport.url, 4096) ||
      !text(transport.owningServiceId, 128) ||
      !/^\S+$/.test(transport.owningServiceId) ||
      !text(transport.apiKey, 128) ||
      !/^\S+$/.test(transport.apiKey) ||
      !text(transport.apiSecret, 256) ||
      !Number.isSafeInteger(transport.timeoutMs) ||
      (transport.timeoutMs as number) < 1 ||
      (transport.timeoutMs as number) > 9000
    )
      invalid();
    const url = new URL(transport.url);
    if (
      url.protocol !== 'https:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== USER_ACTION_RETIREMENT_PATH ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      invalid();
  } else if (
    ['releaseBarrier', 'expirePreSignLeases', 'inspectCounters', 'shutdown'].includes(
      raw.command as string,
    )
  )
    object(value, ['protocol', 'commandId', 'command']);
  else invalid();
  return value as PairedCommand;
}
