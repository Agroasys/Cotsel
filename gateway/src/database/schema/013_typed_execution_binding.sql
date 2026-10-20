ALTER TABLE settlement_handoffs ADD COLUMN execution_binding JSONB;

CREATE FUNCTION protect_typed_execution_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.execution_binding IS NOT NULL THEN RAISE EXCEPTION 'typed_execution_binding_is_immutable'; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.execution_binding IS DISTINCT FROM OLD.execution_binding THEN
        RAISE EXCEPTION 'typed_execution_binding_is_immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.execution_binding IS NOT NULL AND
       ROW(NEW.platform_id,NEW.platform_handoff_id,NEW.trade_id,NEW.phase,NEW.settlement_channel,
           NEW.display_currency,NEW.display_amount,NEW.asset_symbol,NEW.asset_amount,NEW.ricardian_hash,
           NEW.external_reference,NEW.source_api_key_id)
       IS DISTINCT FROM
       ROW(OLD.platform_id,OLD.platform_handoff_id,OLD.trade_id,OLD.phase,OLD.settlement_channel,
           OLD.display_currency,OLD.display_amount,OLD.asset_symbol,OLD.asset_amount,OLD.ricardian_hash,
           OLD.external_reference,OLD.source_api_key_id) THEN
        RAISE EXCEPTION 'typed_execution_binding_identity_is_immutable';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.phase = 'gasless_create_trade' THEN
        IF jsonb_typeof(NEW.execution_binding) IS DISTINCT FROM 'object'
          OR NEW.execution_binding->>'scopeVersion' IS DISTINCT FROM 'agroasys.cotsel-execution-binding.v1'
          OR NEW.source_api_key_id IS NULL
          OR NEW.execution_binding->>'ownerServiceId' IS DISTINCT FROM NEW.source_api_key_id
          OR NEW.external_reference IS NULL
          OR NEW.execution_binding->>'sourceOperationId' IS DISTINCT FROM NEW.external_reference
          OR (NEW.execution_binding ?& ARRAY['packageId','approvalScopeFingerprint','chainId','escrowAddress','tokenAddress','buyerAddress','supplierAddress','ricardianHash','totalAmount','logisticsAmount','platformFeesAmount','supplierFirstTranche','supplierSecondTranche','expiresAt','buyerAuthorization','usdcAuthorization','executionScopeHash']) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'complete_owned_execution_binding_required';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER typed_execution_binding_immutable
BEFORE INSERT OR UPDATE OR DELETE ON settlement_handoffs
FOR EACH ROW EXECUTE FUNCTION protect_typed_execution_binding();
