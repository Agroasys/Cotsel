ALTER TABLE oracle_triggers ADD COLUMN funded_binding jsonb;
CREATE FUNCTION preserve_oracle_funded_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF jsonb_typeof(NEW.funded_binding) IS DISTINCT FROM 'object' OR
   NEW.funded_binding->>'scopeVersion' IS DISTINCT FROM 'agroasys.funded-settlement-binding.v1' OR
   NEW.funded_binding->>'tradeId' IS DISTINCT FROM NEW.trade_id OR
   (NEW.funded_binding ?& ARRAY['ownerServiceId','sourceOperationId','phase','chainId','escrowAddress','tokenAddress','buyerAddress','supplierAddress','ricardianHash','totalAmount','logisticsAmount','platformFeesAmount','supplierFirstTranche','supplierSecondTranche','supplierPayoutAmount','treasuryAccrualAmount','buyerRefundAmount','fundingTransactionHash','fundingBlockNumber','fundingBlockHash','originalFundingFingerprint']) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'complete_original_funded_binding_required';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.funded_binding IS NOT NULL THEN RAISE EXCEPTION 'oracle_funded_binding_is_retained'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.funded_binding IS DISTINCT FROM OLD.funded_binding OR
   OLD.funded_binding IS NOT NULL AND ROW(NEW.trade_id,NEW.trigger_type,NEW.action_key,NEW.request_id,NEW.idempotency_key) IS DISTINCT FROM ROW(OLD.trade_id,OLD.trigger_type,OLD.action_key,OLD.request_id,OLD.idempotency_key) THEN
  RAISE EXCEPTION 'oracle_funded_binding_is_immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER oracle_funded_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON oracle_triggers
FOR EACH ROW EXECUTE FUNCTION preserve_oracle_funded_binding();
