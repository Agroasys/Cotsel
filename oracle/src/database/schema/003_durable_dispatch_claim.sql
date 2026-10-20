ALTER TABLE oracle_triggers ADD COLUMN dispatch_started_at timestamptz;
-- Apply while Oracle mutation workers are stopped; the retained runner uses a transaction.
SET LOCAL lock_timeout='5s';
CREATE UNIQUE INDEX one_original_oracle_dispatch_per_action ON oracle_triggers(action_key) WHERE dispatch_started_at IS NOT NULL;
CREATE FUNCTION preserve_oracle_dispatch_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.dispatch_started_at IS NOT NULL THEN RAISE EXCEPTION 'oracle_dispatch_claim_is_retained'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN RAISE EXCEPTION 'oracle_dispatch_claim_is_immutable'; END IF;
 IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN RAISE EXCEPTION 'oracle_original_transaction_is_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER oracle_dispatch_claim_guard BEFORE UPDATE OR DELETE ON oracle_triggers FOR EACH ROW EXECUTE FUNCTION preserve_oracle_dispatch_claim();
