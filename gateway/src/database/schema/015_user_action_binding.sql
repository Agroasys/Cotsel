-- New requests require owned immutable instructions. Historical rows remain observable.
CREATE FUNCTION require_user_action_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.phase='gasless_user_action' THEN
  IF jsonb_typeof(NEW.execution_binding) IS DISTINCT FROM 'object'
    OR NEW.execution_binding->>'scopeVersion' IS DISTINCT FROM 'agroasys.cotsel-user-action-binding.v1'
    OR NEW.source_api_key_id IS NULL
    OR NEW.execution_binding->>'ownerServiceId' IS DISTINCT FROM NEW.source_api_key_id
    OR NEW.execution_binding->>'sourceOperationId' IS DISTINCT FROM NEW.external_reference
    OR NEW.external_reference IS NULL
    OR NEW.execution_binding->>'tradeId' IS DISTINCT FROM NEW.trade_id
    OR NEW.execution_binding->>'phase' IS DISTINCT FROM NEW.phase
    OR (NEW.execution_binding ?& ARRAY['packageId','approvalScopeFingerprint','originalFundingFingerprint','action','signerRole','signerAddress','buyerAddress','supplierAddress','chainId','escrowAddress','tokenAddress','deploymentIdentity','nonce','deadline','expiresAt','recipient','amount','totalAmount','supplierSecondTranche','fundingTransactionHash','fundingBlockNumber','fundingBlockHash','executionScopeHash']) IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'complete_owned_user_action_binding_required'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER user_action_binding_guard BEFORE INSERT ON settlement_handoffs
FOR EACH ROW EXECUTE FUNCTION require_user_action_binding();
