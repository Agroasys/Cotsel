/** SPDX-License-Identifier: Apache-2.0 */

export const SETTLEMENT_CALLBACK_EVENT = {
  type: 'cotsel.settlement-callback',
  version: 'v1',
  producer: 'gateway',
  outbox: 'settlement_callback_deliveries',
} as const;

/** The registered HTTP payload remains unchanged inside the additive outbox envelope. */
export function buildSettlementCallbackEnvelope(payload: Record<string, unknown>, eventId: string) {
  if (
    payload.contractVersion !==
      `${SETTLEMENT_CALLBACK_EVENT.type}.${SETTLEMENT_CALLBACK_EVENT.version}` ||
    payload.eventId !== eventId ||
    !eventId ||
    typeof payload.tradeId !== 'string' ||
    !payload.tradeId ||
    typeof payload.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.observedAt))
  ) {
    throw new Error('Invalid or unregistered settlement callback envelope payload');
  }
  return {
    eventId,
    type: SETTLEMENT_CALLBACK_EVENT.type,
    schemaVersion: SETTLEMENT_CALLBACK_EVENT.version,
    producer: SETTLEMENT_CALLBACK_EVENT.producer,
    settlementId: payload.tradeId,
    orderingKey: payload.tradeId,
    occurredAt: payload.observedAt,
    payload,
  };
}
