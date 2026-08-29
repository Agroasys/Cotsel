/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'crypto';
import { GatewayError } from '../errors';
import { validateExecutionTransition } from './settlementStateMachine';
import type {
  SettlementCallbackDeliveryRecord,
  SettlementExecutionEventRecord,
  SettlementHandoffRecord,
  SettlementStore,
  TradeSettlementProjection,
} from './settlementStore';

export function createInMemorySettlementStore(
  initialHandoffs: SettlementHandoffRecord[] = [],
): SettlementStore {
  const handoffs = new Map(
    initialHandoffs.map((record) => [record.handoffId, structuredClone(record)]),
  );
  const platformIndex = new Map(
    initialHandoffs.map((record) => [
      `${record.platformId}:${record.platformHandoffId}`,
      record.handoffId,
    ]),
  );
  const events = new Map<string, SettlementExecutionEventRecord[]>();
  const eventDedupeIndex = new Map<string, string>();
  const deliveries = new Map<string, SettlementCallbackDeliveryRecord>();

  const byTrade = (tradeId: string) =>
    [...handoffs.values()]
      .filter((record) => record.tradeId === tradeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  return {
    async createHandoff(input) {
      const key = `${input.platformId}:${input.platformHandoffId}`;
      const existingId = platformIndex.get(key);
      if (existingId) {
        return structuredClone(handoffs.get(existingId)!);
      }

      const now = new Date().toISOString();
      const record: SettlementHandoffRecord = {
        handoffId: randomUUID(),
        platformId: input.platformId,
        platformHandoffId: input.platformHandoffId,
        tradeId: input.tradeId,
        phase: input.phase,
        settlementChannel: input.settlementChannel,
        displayCurrency: input.displayCurrency,
        displayAmount: input.displayAmount,
        assetSymbol: input.assetSymbol ?? null,
        assetAmount: input.assetAmount ?? null,
        ricardianHash: input.ricardianHash ?? null,
        externalReference: input.externalReference ?? null,
        metadata: structuredClone(input.metadata ?? {}),
        executionStatus: 'pending',
        reconciliationStatus: 'pending',
        callbackStatus: 'pending',
        providerStatus: null,
        txHash: null,
        latestEventId: null,
        latestEventType: null,
        latestEventDetail: null,
        latestEventAt: null,
        callbackDeliveredAt: null,
        requestId: input.requestId,
        sourceApiKeyId: input.sourceApiKeyId ?? null,
        createdAt: now,
        updatedAt: now,
      };

      handoffs.set(record.handoffId, record);
      platformIndex.set(key, record.handoffId);
      return structuredClone(record);
    },

    async getHandoff(handoffId) {
      const record = handoffs.get(handoffId);
      return record ? structuredClone(record) : null;
    },

    async getHandoffByPlatformRef(platformId, platformHandoffId) {
      const record = handoffs.get(platformIndex.get(`${platformId}:${platformHandoffId}`) ?? '');
      return record ? structuredClone(record) : null;
    },

    async listHandoffs(input) {
      const filtered = [...handoffs.values()]
        .filter((record) => (input.tradeId ? record.tradeId === input.tradeId : true))
        .filter((record) =>
          input.reconciliationStatus
            ? record.reconciliationStatus === input.reconciliationStatus
            : true,
        )
        .filter((record) =>
          input.executionStatus ? record.executionStatus === input.executionStatus : true,
        )
        .sort((left, right) => {
          const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
          if (updatedOrder !== 0) {
            return updatedOrder;
          }

          return right.handoffId.localeCompare(left.handoffId);
        });

      return {
        items: filtered
          .slice(input.offset, input.offset + input.limit)
          .map((record) => structuredClone(record)),
        total: filtered.length,
        sourceFreshAt: filtered[0]?.updatedAt ?? null,
      };
    },

    async recordExecutionEvent(input, callback) {
      const handoff = handoffs.get(input.handoffId);
      if (!handoff) {
        throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
          handoffId: input.handoffId,
        });
      }

      const dedupeIndexKey = `${input.handoffId}:${input.dedupeKey}`;
      const existingEventId = eventDedupeIndex.get(dedupeIndexKey);
      if (existingEventId) {
        const event = (events.get(input.handoffId) ?? []).find(
          (candidate) => candidate.eventId === existingEventId,
        );
        if (!event) {
          throw new GatewayError(
            500,
            'INTERNAL_ERROR',
            'Settlement event dedupe index is inconsistent',
            { handoffId: input.handoffId, eventId: existingEventId },
          );
        }

        let callbackDelivery = [...deliveries.values()].find(
          (delivery) => delivery.eventId === event.eventId,
        );
        if (!callbackDelivery) {
          const now = new Date().toISOString();
          callbackDelivery = {
            deliveryId: randomUUID(),
            handoffId: input.handoffId,
            eventId: event.eventId,
            targetUrl: callback.targetUrl,
            requestBody: structuredClone(callback.buildRequestBody(handoff, event)),
            status: callback.status,
            attemptCount: 0,
            nextAttemptAt: callback.nextAttemptAt,
            lastAttemptedAt: null,
            deliveredAt: null,
            responseStatus: null,
            lastError: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            requestId: callback.requestId,
            createdAt: now,
            updatedAt: now,
          };
          deliveries.set(callbackDelivery.deliveryId, callbackDelivery);
          if (callback.status === 'disabled') {
            handoffs.set(input.handoffId, {
              ...handoff,
              callbackStatus: 'disabled',
              updatedAt: now,
            });
          }
        }

        return {
          handoff: structuredClone(handoffs.get(input.handoffId)!),
          event: structuredClone(event),
          callbackDelivery: structuredClone(callbackDelivery),
        };
      }

      validateExecutionTransition(handoff.executionStatus, input.executionStatus, input.eventType);

      const now = new Date().toISOString();
      const event: SettlementExecutionEventRecord = {
        eventId: randomUUID(),
        handoffId: input.handoffId,
        eventType: input.eventType,
        executionStatus: input.executionStatus,
        reconciliationStatus: input.reconciliationStatus,
        providerStatus: input.providerStatus ?? null,
        txHash: input.txHash ?? null,
        detail: input.detail ?? null,
        metadata: structuredClone(input.metadata ?? {}),
        observedAt: input.observedAt,
        requestId: input.requestId,
        sourceApiKeyId: input.sourceApiKeyId ?? null,
        createdAt: now,
      };

      const updatedHandoff: SettlementHandoffRecord = {
        ...handoff,
        executionStatus: input.executionStatus,
        reconciliationStatus: input.reconciliationStatus,
        callbackStatus: handoff.callbackStatus === 'disabled' ? 'disabled' : 'pending',
        providerStatus: input.providerStatus ?? handoff.providerStatus,
        txHash: input.txHash ?? handoff.txHash,
        latestEventId: event.eventId,
        latestEventType: input.eventType,
        latestEventDetail: input.detail ?? null,
        latestEventAt: input.observedAt,
        updatedAt: now,
      };
      const callbackDelivery: SettlementCallbackDeliveryRecord = {
        deliveryId: randomUUID(),
        handoffId: input.handoffId,
        eventId: event.eventId,
        targetUrl: callback.targetUrl,
        requestBody: structuredClone(callback.buildRequestBody(updatedHandoff, event)),
        status: callback.status,
        attemptCount: 0,
        nextAttemptAt: callback.nextAttemptAt,
        lastAttemptedAt: null,
        deliveredAt: null,
        responseStatus: null,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        requestId: callback.requestId,
        createdAt: now,
        updatedAt: now,
      };
      const finalHandoff =
        callback.status === 'disabled'
          ? { ...updatedHandoff, callbackStatus: 'disabled' as const }
          : updatedHandoff;

      const bucket = events.get(input.handoffId) ?? [];
      bucket.unshift(event);
      events.set(input.handoffId, bucket);
      eventDedupeIndex.set(dedupeIndexKey, event.eventId);
      deliveries.set(callbackDelivery.deliveryId, callbackDelivery);
      handoffs.set(input.handoffId, finalHandoff);

      return {
        handoff: structuredClone(finalHandoff),
        event: structuredClone(event),
        callbackDelivery: structuredClone(callbackDelivery),
      };
    },

    async listExecutionEvents(handoffId) {
      return structuredClone(events.get(handoffId) ?? []);
    },

    async getDueCallbackDeliveries(limit, now) {
      return [...deliveries.values()]
        .filter(
          (delivery) =>
            ((delivery.status === 'pending' || delivery.status === 'failed') &&
              delivery.nextAttemptAt <= now) ||
            (delivery.status === 'delivering' &&
              delivery.leaseExpiresAt !== null &&
              delivery.leaseExpiresAt <= now),
        )
        .sort((left, right) =>
          (left.leaseExpiresAt ?? left.nextAttemptAt).localeCompare(
            right.leaseExpiresAt ?? right.nextAttemptAt,
          ),
        )
        .slice(0, limit)
        .map((delivery) => structuredClone(delivery));
    },

    async getCallbackDelivery(deliveryId) {
      const delivery = deliveries.get(deliveryId);
      return delivery ? structuredClone(delivery) : null;
    },

    async markCallbackDelivering(deliveryId, leaseOwner, attemptedAt, leaseExpiresAt) {
      const delivery = deliveries.get(deliveryId);
      const ready =
        delivery &&
        (((delivery.status === 'pending' || delivery.status === 'failed') &&
          delivery.nextAttemptAt <= attemptedAt) ||
          (delivery.status === 'delivering' &&
            delivery.leaseExpiresAt !== null &&
            delivery.leaseExpiresAt <= attemptedAt));
      if (!delivery || !ready) {
        return null;
      }

      const next = {
        ...delivery,
        status: 'delivering' as const,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptedAt: attemptedAt,
        leaseOwner,
        leaseExpiresAt,
        updatedAt: new Date().toISOString(),
      };
      deliveries.set(deliveryId, next);
      return structuredClone(next);
    },

    async markCallbackDelivered(deliveryId, leaseOwner, completedAt, responseStatus) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery || delivery.status !== 'delivering' || delivery.leaseOwner !== leaseOwner) {
        return false;
      }

      deliveries.set(deliveryId, {
        ...delivery,
        status: 'delivered',
        deliveredAt: completedAt,
        responseStatus,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date().toISOString(),
      });
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: 'delivered',
          callbackDeliveredAt: completedAt,
          updatedAt: new Date().toISOString(),
        });
      }
      return true;
    },

    async markCallbackFailed(deliveryId, leaseOwner, update) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery || delivery.status !== 'delivering' || delivery.leaseOwner !== leaseOwner) {
        return false;
      }

      deliveries.set(deliveryId, {
        ...delivery,
        status: update.deadLetter ? 'dead_letter' : 'failed',
        responseStatus: update.responseStatus ?? null,
        lastError: update.errorMessage,
        nextAttemptAt: update.nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date().toISOString(),
      });
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: update.deadLetter ? 'dead_letter' : 'failed',
          updatedAt: new Date().toISOString(),
        });
      }
      return true;
    },

    async requeueCallbackDelivery(deliveryId, nextAttemptAt) {
      const delivery = deliveries.get(deliveryId);
      if (!delivery || delivery.status !== 'dead_letter') {
        return null;
      }

      const next = {
        ...delivery,
        status: 'pending' as const,
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date().toISOString(),
      };
      deliveries.set(deliveryId, next);
      const handoff = handoffs.get(delivery.handoffId);
      if (handoff && handoff.latestEventId === delivery.eventId) {
        handoffs.set(delivery.handoffId, {
          ...handoff,
          callbackStatus: 'pending',
          updatedAt: new Date().toISOString(),
        });
      }
      return structuredClone(next);
    },

    async getTradeSettlementProjectionMap(tradeIds) {
      const map = new Map<string, TradeSettlementProjection>();
      for (const tradeId of tradeIds) {
        const record = byTrade(tradeId);
        if (!record) {
          continue;
        }
        map.set(tradeId, {
          handoffId: record.handoffId,
          platformId: record.platformId,
          platformHandoffId: record.platformHandoffId,
          phase: record.phase,
          settlementChannel: record.settlementChannel,
          displayCurrency: record.displayCurrency,
          displayAmount: record.displayAmount,
          executionStatus: record.executionStatus,
          reconciliationStatus: record.reconciliationStatus,
          callbackStatus: record.callbackStatus,
          providerStatus: record.providerStatus,
          txHash: record.txHash,
          externalReference: record.externalReference,
          latestEventType: record.latestEventType,
          latestEventDetail: record.latestEventDetail,
          latestEventAt: record.latestEventAt,
          callbackDeliveredAt: record.callbackDeliveredAt,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
      return map;
    },
  };
}
