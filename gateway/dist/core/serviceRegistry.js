"use strict";
/**
 * SPDX-License-Identifier: Apache-2.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDownstreamServiceRegistry = createDownstreamServiceRegistry;
function createDownstreamServiceRegistry(contracts) {
    const byKey = new Map(contracts.map((contract) => [contract.key, contract]));
    return {
        get(service) {
            const contract = byKey.get(service);
            if (!contract) {
                throw new Error(`Downstream service contract is not registered: ${service}`);
            }
            return contract;
        },
        list() {
            return [...byKey.values()];
        },
    };
}
//# sourceMappingURL=serviceRegistry.js.map