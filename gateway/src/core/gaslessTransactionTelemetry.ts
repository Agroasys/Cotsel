/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Logger } from '../logging/logger';
import type { GaslessTransactionIdentity } from './gaslessTransactionOutcomeStore';

type GaslessSignerCustodyMode = 'raw_private_key' | 'kms' | 'mpc';
type GaslessTransactionTelemetryContext = Pick<
  GaslessTransactionIdentity,
  'applicationRequestId' | 'resourceType' | 'resourceId' | 'operation'
>;

export function logGaslessSigningStarted(
  context: GaslessTransactionTelemetryContext,
  custodyMode: GaslessSignerCustodyMode,
): void {
  Logger.info('Gasless transaction signing started', {
    eventType: 'gateway.gasless_transaction.signing_started',
    applicationRequestId: context.applicationRequestId,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    operation: context.operation,
    custodyMode,
  });
}

export function logGaslessSigningCompleted(
  context: GaslessTransactionTelemetryContext,
  custodyMode: GaslessSignerCustodyMode,
): void {
  Logger.info('Gasless transaction signing completed', {
    eventType: 'gateway.gasless_transaction.signing_completed',
    applicationRequestId: context.applicationRequestId,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    operation: context.operation,
    custodyMode,
  });
}

export function logGaslessIdentityPersisted(identity: GaslessTransactionIdentity): void {
  Logger.info('Gasless transaction identity persisted before broadcast', {
    eventType: 'gateway.gasless_transaction.identity_persisted',
    applicationRequestId: identity.applicationRequestId,
    resourceType: identity.resourceType,
    resourceId: identity.resourceId,
    operation: identity.operation,
    transactionHash: identity.transactionHash,
    signerAddress: identity.signerAddress,
    nonce: identity.nonce,
  });
}

export function logGaslessBroadcastResponse(
  identity: GaslessTransactionIdentity,
  responseHash: string,
): void {
  Logger.info('Gasless provider returned a broadcast response', {
    eventType: 'gateway.gasless_transaction.broadcast_response',
    applicationRequestId: identity.applicationRequestId,
    resourceType: identity.resourceType,
    resourceId: identity.resourceId,
    operation: identity.operation,
    transactionHash: identity.transactionHash,
    responseHash,
  });
}

export function logGaslessConfirmationPending(identity: GaslessTransactionIdentity): void {
  Logger.info('Gasless transaction awaits confirmation', {
    eventType: 'gateway.gasless_transaction.confirmation_pending',
    applicationRequestId: identity.applicationRequestId,
    resourceType: identity.resourceType,
    resourceId: identity.resourceId,
    operation: identity.operation,
    transactionHash: identity.transactionHash,
  });
}
