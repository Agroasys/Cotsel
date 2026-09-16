-- SPDX-License-Identifier: Apache-2.0

-- Require immutable point-in-time simulation evidence on every newly prepared
-- governance action. The evidence is context for review, not an on-chain expiry
-- or a guarantee that chain state cannot change after simulation.
ALTER TABLE governance_actions
    DROP CONSTRAINT IF EXISTS governance_actions_payload_shape;

ALTER TABLE governance_actions
    ADD CONSTRAINT governance_actions_payload_shape CHECK (
        jsonb_typeof(prepared_signing_payload) = 'object'
        AND prepared_signing_payload ?& ARRAY[
            'actionId', 'intentKey', 'actionType', 'proposalId', 'expiresAt',
            'auditReference', 'chainId', 'contractAddress', 'contractMethod',
            'args', 'txRequest', 'signerWallet', 'simulation', 'preparedPayloadHash'
        ]
        AND jsonb_typeof(prepared_signing_payload -> 'simulation') = 'object'
        AND (prepared_signing_payload -> 'simulation') ?& ARRAY[
            'chainId', 'blockNumber', 'blockHash', 'simulatedAt',
            'providerIdentity', 'result', 'returnDataHash', 'pointInTimeOnly'
        ]
        AND prepared_signing_payload -> 'simulation' ->> 'result' = 'success'
        AND prepared_signing_payload -> 'simulation' ->> 'pointInTimeOnly' = 'true'
    );
