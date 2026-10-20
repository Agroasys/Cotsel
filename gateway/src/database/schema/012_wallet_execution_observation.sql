ALTER TABLE gasless_transaction_outcomes ADD COLUMN source_api_key_id VARCHAR(128);
-- The retained resource_type/resource_id index bounds the service-scoped lookup.

-- Retained transaction identity cannot be reassigned to another issuing service or resource.
CREATE FUNCTION preserve_gasless_transaction_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF ROW(NEW.transaction_hash,NEW.application_request_id,NEW.resource_type,NEW.resource_id,NEW.operation,
        NEW.chain_id,NEW.signer_address,NEW.transaction_nonce,NEW.transaction_type,NEW.destination_address,NEW.value_wei,
        NEW.gas_limit,NEW.max_fee_per_gas_wei,NEW.max_priority_fee_per_gas_wei,NEW.gas_price_wei,NEW.calldata_hash,NEW.intent_hash,NEW.source_api_key_id)
    IS DISTINCT FROM ROW(OLD.transaction_hash,OLD.application_request_id,OLD.resource_type,OLD.resource_id,OLD.operation,
        OLD.chain_id,OLD.signer_address,OLD.transaction_nonce,OLD.transaction_type,OLD.destination_address,OLD.value_wei,
        OLD.gas_limit,OLD.max_fee_per_gas_wei,OLD.max_priority_fee_per_gas_wei,OLD.gas_price_wei,OLD.calldata_hash,OLD.intent_hash,OLD.source_api_key_id)
 THEN RAISE EXCEPTION 'gasless_transaction_identity_is_immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER gasless_transaction_identity_immutable BEFORE UPDATE ON gasless_transaction_outcomes
FOR EACH ROW EXECUTE FUNCTION preserve_gasless_transaction_identity();
