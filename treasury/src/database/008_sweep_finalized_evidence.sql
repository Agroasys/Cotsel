-- Retain the exact sweep receipt evidence independently of later accounting lifecycle annotations.
CREATE FUNCTION preserve_sweep_finalized_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.metadata ? 'settlementFinalizedEvidence' THEN RAISE EXCEPTION 'sweep_finalized_evidence_is_retained'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.metadata ? 'settlementFinalizedEvidence' AND
  (NEW.metadata->'settlementFinalizedEvidence' IS DISTINCT FROM OLD.metadata->'settlementFinalizedEvidence' OR
   ROW(NEW.matched_sweep_tx_hash,NEW.matched_sweep_block_number,NEW.payout_receiver_address,NEW.expected_total_raw,NEW.asset_symbol)
   IS DISTINCT FROM ROW(OLD.matched_sweep_tx_hash,OLD.matched_sweep_block_number,OLD.payout_receiver_address,OLD.expected_total_raw,OLD.asset_symbol)) THEN
  RAISE EXCEPTION 'sweep_finalized_evidence_is_immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sweep_finalized_evidence_guard BEFORE UPDATE OR DELETE ON sweep_batches FOR EACH ROW EXECUTE FUNCTION preserve_sweep_finalized_evidence();
