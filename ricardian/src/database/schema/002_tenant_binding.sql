-- Binds each Ricardian registration to the tenant that registered it. Complete terms and
-- metadata are retrievable only by that tenant; generic lookup returns a minimal attestation.
-- Rows registered before this migration have no tenant and are never returned in full.
ALTER TABLE ricardian_hashes ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(128);

ALTER TABLE ricardian_hashes DROP CONSTRAINT IF EXISTS ck_ricardian_hashes_tenant_id;
ALTER TABLE ricardian_hashes ADD CONSTRAINT ck_ricardian_hashes_tenant_id
    CHECK (tenant_id IS NULL OR tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

CREATE INDEX IF NOT EXISTS idx_ricardian_hash_tenant ON ricardian_hashes(hash, tenant_id);
