# Community Demo Checklist — Agroasys Non-Custodial Settlement

## Purpose

Provide a repeatable, operator-safe checklist for public pilot demonstrations of the Agroasys non-custodial settlement lifecycle.

## Who This Is For

- `Demo Operator`: executes demo flow and narrates protocol steps.
- `On-call Engineer`: monitors environment health during live demo.
- `Pilot Owner`: approves readiness and go/no-go before audience engagement.

## Data Redaction Requirements

- [ ] `.env` files are not visible in any screen share or captured artifact.
- [ ] Webhook URLs containing credentials are masked.
- [ ] HMAC signatures and API keys are not visible in any captured terminal output.

## Operational Safety Controls

- [ ] Demo runs against `staging-e2e-real` profile.
- [ ] Oracle signing key is a dedicated demo key, never reuse pilot or production oracle keys.
- [ ] `TREASURY_AUTH_ENABLED=true` on staging, confirm auth headers are tested before go-live.
- [ ] Screen share preview reviewed before audience is admitted.

## Pre-Demo Environment Readiness Checklist

### 1. Environment validation

- [ ] `.env` and `.env.staging-e2e-real` populated with demo values.
- [ ] Run env validation:

```bash
scripts/validate-env.sh staging-e2e-real
```

- [ ] Output includes `env validation passed for profile: staging-e2e-real`.

### 2. Services healthy

- [ ] Bring up demo profile:

```bash
scripts/docker-services.sh down staging-e2e-real
scripts/docker-services.sh up staging-e2e-real
scripts/docker-services.sh health staging-e2e-real
```

- [ ] All required services running: `postgres`, `redis`, `indexer-pipeline`, `indexer-graphql`, `oracle`, `reconciliation`, `ricardian`, `treasury`.

### 3. Release gate passes

- [ ] Run gate:

```bash
scripts/staging-e2e-real-gate.sh
```

- [ ] Gate reports schema parity, lag metrics, reorg/resync probe, reconciliation summary, and drift snapshot, all green.

### 4. Health endpoint spot-checks

- [ ] Ricardian:

```bash
curl -fsS "http://127.0.0.1:${RICARDIAN_PORT:-3100}/api/ricardian/v1/health"
```

- [ ] Treasury:

```bash
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/health"
curl -fsS "http://127.0.0.1:${TREASURY_PORT:-3200}/api/treasury/v1/ready"
```

- [ ] Oracle:

```bash
curl -fsS http://127.0.0.1:${ORACLE_PORT:-3001}/api/oracle/health
curl -fsS http://127.0.0.1:${ORACLE_PORT:-3001}/api/oracle/ready
```

### 5. Final go/no-go

- [ ] Demo Operator sign-off.
- [ ] On-call Engineer sign-off.
- [ ] Pilot Owner sign-off.

## Post-Demo Checklist

- [ ] Stop demo profile:

```bash
scripts/docker-services.sh down staging-e2e-real
```

- [ ] Rotate demo oracle signing key.
- [ ] Rotate any demo API keys used during the session.
- [ ] Archive demo logs to incident/evidence store (do not publish raw logs publicly).
- [ ] Confirm no real credentials were captured in any recording or screenshot.
