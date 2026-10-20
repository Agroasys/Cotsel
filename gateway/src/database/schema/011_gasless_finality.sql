ALTER TABLE gasless_transaction_outcomes ADD COLUMN finality_evidence JSONB;
ALTER TABLE gasless_transaction_outcome_events ADD COLUMN finality_evidence JSONB;
ALTER TABLE settlement_execution_events DROP CONSTRAINT settlement_execution_events_event_type_check;
ALTER TABLE settlement_execution_events ADD CONSTRAINT settlement_execution_events_event_type_check CHECK (event_type IN (
 'accepted','queued','simulation_completed','broadcast_unknown','confirmation_pending','submitted','confirmed','reverted','replaced','failed','rejected','reconciled','drift_detected','chain_evidence_orphaned'
)) NOT VALID;
