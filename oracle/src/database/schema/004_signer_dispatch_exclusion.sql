-- Stop Oracle mutation workers before applying this transactional migration.
SET LOCAL lock_timeout='5s';
ALTER TABLE oracle_triggers ADD COLUMN dispatch_signer_scope text, ADD COLUMN dispatch_finality_evidence jsonb;
ALTER TABLE oracle_triggers ADD CONSTRAINT oracle_dispatch_signer_scope_shape CHECK(dispatch_signer_scope IS NULL OR dispatch_signer_scope ~ '^[1-9][0-9]*:0x[0-9a-f]{40}$');
CREATE UNIQUE INDEX one_unresolved_oracle_dispatch_per_signer ON oracle_triggers(dispatch_signer_scope) WHERE dispatch_started_at IS NOT NULL AND dispatch_finality_evidence IS NULL;
CREATE FUNCTION protect_oracle_dispatch_resolution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND (NEW.dispatch_started_at IS NOT NULL OR NEW.dispatch_finality_evidence IS NOT NULL) THEN RAISE EXCEPTION 'oracle_dispatch_requires_existing_operation'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.dispatch_started_at IS NULL AND NEW.dispatch_finality_evidence IS NOT NULL THEN RAISE EXCEPTION 'oracle_original_dispatch_evidence_required'; END IF;
  IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_signer_scope IS DISTINCT FROM OLD.dispatch_signer_scope THEN RAISE EXCEPTION 'oracle_dispatch_signer_is_immutable'; END IF;
  IF OLD.dispatch_finality_evidence IS NOT NULL AND NEW.dispatch_finality_evidence IS DISTINCT FROM OLD.dispatch_finality_evidence THEN RAISE EXCEPTION 'oracle_dispatch_resolution_is_immutable'; END IF;
  IF OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL AND (NEW.dispatch_signer_scope IS NULL OR split_part(NEW.dispatch_signer_scope,':',1) IS DISTINCT FROM NEW.funded_binding->>'chainId') THEN RAISE EXCEPTION 'oracle_dispatch_signer_scope_required'; END IF;
 END IF;
 IF NEW.dispatch_finality_evidence IS NOT NULL AND (
   jsonb_typeof(NEW.dispatch_finality_evidence) IS DISTINCT FROM 'object' OR
   NEW.dispatch_finality_evidence->>'policy' IS DISTINCT FROM 'oracle_dispatch_nonce_finality_v1' OR
   NEW.dispatch_finality_evidence->>'signerScope' IS DISTINCT FROM NEW.dispatch_signer_scope OR
   NEW.dispatch_signer_scope IS NULL OR NEW.tx_hash IS NULL OR
   NEW.dispatch_finality_evidence->>'transactionHash' IS DISTINCT FROM NEW.tx_hash OR
   coalesce(NEW.dispatch_finality_evidence->>'blockHash','') !~ '^0x[0-9a-f]{64}$' OR
   coalesce(NEW.dispatch_finality_evidence->>'blockNumber','') !~ '^(0|[1-9][0-9]*)$' OR
   coalesce(NEW.dispatch_finality_evidence->>'receiptStatus','') NOT IN ('0','1') OR
   jsonb_typeof(NEW.dispatch_finality_evidence->'witnessIds') IS DISTINCT FROM 'array' OR
   jsonb_array_length(NEW.dispatch_finality_evidence->'witnessIds') IS DISTINCT FROM 2 OR
   coalesce(NEW.dispatch_finality_evidence->'witnessIds'->>0,'') !~ '^[0-9a-f]{64}$' OR
   coalesce(NEW.dispatch_finality_evidence->'witnessIds'->>1,'') !~ '^[0-9a-f]{64}$' OR
   (NEW.dispatch_finality_evidence->'witnessIds'->>0) IS NOT DISTINCT FROM (NEW.dispatch_finality_evidence->'witnessIds'->>1) OR
   NOT (NEW.dispatch_finality_evidence ?& ARRAY['blockNumber','blockHash','receiptStatus','witnessIds','verifiedAt'])
 ) THEN RAISE EXCEPTION 'oracle_original_dispatch_evidence_required'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER oracle_dispatch_resolution_guard BEFORE INSERT OR UPDATE ON oracle_triggers FOR EACH ROW EXECUTE FUNCTION protect_oracle_dispatch_resolution();
