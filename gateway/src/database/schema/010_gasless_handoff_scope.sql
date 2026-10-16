-- An issued execution scope cannot be replaced by a fresh transport request.
CREATE FUNCTION prevent_gasless_handoff_scope_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.metadata ? 'executionScopeHash' THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'accepted_gasless_handoff_scope_is_immutable';
        END IF;
        IF NEW.metadata IS DISTINCT FROM OLD.metadata OR
           NEW.platform_id IS DISTINCT FROM OLD.platform_id OR
           NEW.platform_handoff_id IS DISTINCT FROM OLD.platform_handoff_id OR
           NEW.trade_id IS DISTINCT FROM OLD.trade_id OR
           NEW.external_reference IS DISTINCT FROM OLD.external_reference OR
           NEW.display_currency IS DISTINCT FROM OLD.display_currency OR
           NEW.display_amount IS DISTINCT FROM OLD.display_amount OR
           NEW.asset_symbol IS DISTINCT FROM OLD.asset_symbol OR
           NEW.asset_amount IS DISTINCT FROM OLD.asset_amount OR
           NEW.phase IS DISTINCT FROM OLD.phase OR
           NEW.settlement_channel IS DISTINCT FROM OLD.settlement_channel OR
           NEW.ricardian_hash IS DISTINCT FROM OLD.ricardian_hash OR
           NEW.source_api_key_id IS DISTINCT FROM OLD.source_api_key_id THEN
            RAISE EXCEPTION 'accepted_gasless_handoff_scope_is_immutable';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gasless_handoff_scope_immutable
BEFORE UPDATE OR DELETE ON settlement_handoffs
FOR EACH ROW EXECUTE FUNCTION prevent_gasless_handoff_scope_mutation();
