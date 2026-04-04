"use strict";
/**
 * SPDX-License-Identifier: Apache-2.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OperationsSummaryService = void 0;
const DEFAULT_DEGRADED_LATENCY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;
function toErrorDetail(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
function withTimeout(operation, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Probe timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        operation
            .then((value) => {
            clearTimeout(timeout);
            resolve(value);
        })
            .catch((error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}
function deriveAggregateState(states) {
    if (states.every((state) => state === 'healthy')) {
        return 'healthy';
    }
    if (states.some((state) => state === 'unavailable')) {
        return 'unavailable';
    }
    if (states.some((state) => state === 'stale')) {
        return 'stale';
    }
    return 'degraded';
}
function severityForState(state) {
    switch (state) {
        case 'unavailable':
            return 'high';
        case 'stale':
            return 'medium';
        case 'degraded':
            return 'low';
        case 'healthy':
            return 'low';
        default:
            return 'low';
    }
}
class OperationsSummaryService {
    constructor(probes, now = () => new Date()) {
        this.probes = probes;
        this.now = now;
        this.cache = new Map();
    }
    async getOperationsSummary() {
        const nowValue = this.now();
        const generatedAt = nowValue.toISOString();
        const services = await Promise.all(this.probes.map((probe) => this.evaluateProbe(probe, nowValue)));
        const incidents = this.deriveIncidentSummary(services, generatedAt);
        return {
            state: deriveAggregateState(services.map((service) => service.state)),
            generatedAt,
            services,
            incidents,
        };
    }
    async evaluateProbe(probe, nowValue) {
        const checkedAt = nowValue.toISOString();
        const staleAfterMs = probe.staleAfterMs;
        const degradedLatencyMs = probe.degradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS;
        if (!probe.check) {
            return {
                key: probe.key,
                name: probe.name,
                state: 'unavailable',
                source: probe.source,
                checkedAt,
                firstFailureAt: null,
                lastSuccessAt: null,
                freshnessMs: null,
                staleAfterMs,
                latencyMs: null,
                detail: 'Gateway has no configured health probe for this service',
            };
        }
        const timeoutMs = probe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const startedAtMs = Date.now();
        try {
            await withTimeout(probe.check(), timeoutMs);
            const latencyMs = Date.now() - startedAtMs;
            const state = latencyMs > degradedLatencyMs ? 'degraded' : 'healthy';
            const cacheEntry = this.cache.get(probe.key);
            this.cache.set(probe.key, {
                firstFailureAt: null,
                lastSuccessAt: checkedAt,
                lastLatencyMs: latencyMs,
            });
            return {
                key: probe.key,
                name: probe.name,
                state,
                source: probe.source,
                checkedAt,
                firstFailureAt: null,
                lastSuccessAt: checkedAt,
                freshnessMs: 0,
                staleAfterMs,
                latencyMs,
                ...(state === 'degraded'
                    ? { detail: `Probe latency ${latencyMs}ms exceeded degraded threshold ${degradedLatencyMs}ms` }
                    : {}),
                ...(cacheEntry?.firstFailureAt
                    ? { detail: `Recovered from prior failure observed at ${cacheEntry.firstFailureAt}` }
                    : {}),
            };
        }
        catch (error) {
            const detail = toErrorDetail(error);
            const cacheEntry = this.cache.get(probe.key);
            const lastSuccessAt = cacheEntry?.lastSuccessAt ?? null;
            const lastLatencyMs = cacheEntry?.lastLatencyMs ?? null;
            if (!lastSuccessAt) {
                this.cache.set(probe.key, {
                    firstFailureAt: checkedAt,
                    lastSuccessAt: null,
                    lastLatencyMs: null,
                });
                return {
                    key: probe.key,
                    name: probe.name,
                    state: 'unavailable',
                    source: probe.source,
                    checkedAt,
                    firstFailureAt: checkedAt,
                    lastSuccessAt: null,
                    freshnessMs: null,
                    staleAfterMs,
                    latencyMs: null,
                    detail,
                };
            }
            const freshnessMs = Math.max(0, nowValue.getTime() - Date.parse(lastSuccessAt));
            const state = freshnessMs > staleAfterMs ? 'stale' : 'degraded';
            this.cache.set(probe.key, {
                firstFailureAt: cacheEntry?.firstFailureAt ?? checkedAt,
                lastSuccessAt,
                lastLatencyMs,
            });
            return {
                key: probe.key,
                name: probe.name,
                state,
                source: probe.source,
                checkedAt,
                firstFailureAt: cacheEntry?.firstFailureAt ?? checkedAt,
                lastSuccessAt,
                freshnessMs,
                staleAfterMs,
                latencyMs: lastLatencyMs,
                detail: `Latest probe failed: ${detail}`,
            };
        }
    }
    deriveIncidentSummary(services, generatedAt) {
        const impactedServices = services.filter((service) => service.state !== 'healthy');
        const items = impactedServices.map((service) => ({
            incidentId: `ops-${service.key}-${service.state}`,
            title: `${service.name} is ${service.state}`,
            severity: severityForState(service.state),
            state: 'open',
            sourceServiceKey: service.key,
            firstObservedAt: service.firstFailureAt ?? service.checkedAt,
            lastObservedAt: service.checkedAt,
            ...(service.detail ? { detail: service.detail } : {}),
        }));
        const bySeverity = {
            critical: items.filter((item) => item.severity === 'critical').length,
            high: items.filter((item) => item.severity === 'high').length,
            medium: items.filter((item) => item.severity === 'medium').length,
            low: items.filter((item) => item.severity === 'low').length,
        };
        return {
            state: deriveAggregateState(impactedServices.map((service) => service.state)),
            source: 'gateway_derived',
            generatedAt,
            openCount: items.length,
            bySeverity,
            items,
        };
    }
}
exports.OperationsSummaryService = OperationsSummaryService;
//# sourceMappingURL=operationsSummaryService.js.map