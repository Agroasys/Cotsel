-- The retained execution_binding column and existing immutable identity guard also own progression scopes.
CREATE FUNCTION require_funded_progression_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.phase IN ('initial_release_after_custody_and_documents','inspection_available_standard','inspection_available_packaged_local','final_release_after_inspection_acceptance','final_release_after_notice_deadline','dispute_resolution') AND
  (jsonb_typeof(NEW.execution_binding) IS DISTINCT FROM 'object' OR
   NEW.execution_binding->>'scopeVersion' IS DISTINCT FROM 'agroasys.funded-settlement-binding.v1' OR
   NEW.source_api_key_id IS NULL OR NEW.execution_binding->>'ownerServiceId' IS DISTINCT FROM NEW.source_api_key_id OR
   NEW.execution_binding->>'sourceOperationId' IS DISTINCT FROM NEW.platform_handoff_id OR
   NEW.execution_binding->>'tradeId' IS DISTINCT FROM NEW.trade_id OR
   NEW.execution_binding->>'phase' IS DISTINCT FROM NEW.phase OR
   NEW.execution_binding->>'ricardianHash' IS DISTINCT FROM NEW.ricardian_hash OR
   (NEW.execution_binding ?& ARRAY['chainId','escrowAddress','tokenAddress','buyerAddress','supplierAddress','totalAmount','logisticsAmount','platformFeesAmount','supplierFirstTranche','supplierSecondTranche','supplierPayoutAmount','treasuryAccrualAmount','buyerRefundAmount','fundingTransactionHash','fundingBlockNumber','fundingBlockHash','originalFundingFingerprint']) IS DISTINCT FROM true) THEN
   RAISE EXCEPTION 'complete_owned_funded_progression_binding_required';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER funded_progression_binding_guard BEFORE INSERT ON settlement_handoffs
FOR EACH ROW EXECUTE FUNCTION require_funded_progression_binding();
