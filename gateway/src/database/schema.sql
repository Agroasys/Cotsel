CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    request_method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    request_id TEXT NOT NULL,
    response_status INTEGER,
    response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_body JSONB,
    completed_at TIMESTAMP,
    last_replayed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    request_id TEXT NOT NULL,
    correlation_id TEXT,
    actor_user_id TEXT,
    actor_wallet_address TEXT,
    actor_role TEXT,
    status TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_completed_at ON idempotency_keys(completed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_route_created_at ON audit_log(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created_at ON audit_log(status, created_at DESC);
