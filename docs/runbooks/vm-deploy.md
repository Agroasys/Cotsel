# Cotsel VM Deployment

How to deploy all Cotsel services on a fresh VM.  
One env file. One command. The script either passes completely or fails with a clear error.

## Prerequisites

- Docker and Docker Compose installed
- Git installed
- `python3` and `node` available in PATH (used by the deployment gate)
- Outbound access to your RPC provider and Base Sepolia

---

## Procedure

### 1. Clone the repository

```bash
git clone <repo-url> cotsel
cd cotsel
```

On a subsequent deploy (updating an existing VM):

```bash
git pull
```

---

### 2. Create and fill `.env.runtime`

```bash
cp .env.runtime.example .env.runtime
```

Open `.env.runtime` and fill in every value. Required fields include:

| Field                                      | Description                                     |
| ------------------------------------------ | ----------------------------------------------- |
| `POSTGRES_PASSWORD`                        | Postgres superuser password                     |
| `ORACLE_PRIVATE_KEY`                       | Oracle attester wallet private key              |
| `ORACLE_RPC_URL`                           | Primary RPC endpoint (Base Sepolia)             |
| `RECONCILIATION_RPC_URL`                   | RPC endpoint for reconciliation                 |
| `GATEWAY_RPC_URL`                          | RPC endpoint for gateway reads                  |
| `INDEXER_RPC_ENDPOINT`                     | RPC endpoint for the indexer pipeline           |
| `ORACLE_ESCROW_ADDRESS`                    | Deployed `AgroasysEscrow` contract address      |
| `RECONCILIATION_ESCROW_ADDRESS`            | Same address for reconciliation                 |
| `GATEWAY_ESCROW_ADDRESS`                   | Same address for gateway                        |
| `INDEXER_CONTRACT_ADDRESS`                 | Same address for the indexer                    |
| `ORACLE_USDC_ADDRESS`                      | USDC token address on Base Sepolia              |
| `TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON`   | API keys for Agroasys → Cotsel session exchange |
| `GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON` | API keys for inbound settlement service calls   |

All fields are documented inline in `.env.runtime.example`.

**Do not create `.env`, `.env.staging-e2e-real`, or any other `.env.*` file.**  
The deploy script will refuse to run if any of those exist alongside `.env.runtime`.

---

### 3. Run the deploy script

```bash
scripts/deploy.sh
```

The script runs fully automated:

1. Checks `.env.runtime` exists and contains no placeholder markers
2. Rejects any conflicting `.env.*` files
3. Validates every required env var
4. Builds all container images
5. Starts all services in detached mode
6. Waits for every service to become healthy
7. Runs the full deployment gate (indexer readiness, lag check, reconciliation, reorg probe)
8. Prints a success summary or exits with a clear failure message

**First build takes several minutes.** Subsequent deploys that only change config can skip the build:

```bash
scripts/deploy.sh --skip-build
```

---

### 4. Verify

On success the script prints:

```
──────────────────────────────────────────────────────────────
Deployment complete
  profile:   staging-e2e-real
  env file:  .env.runtime
...
──────────────────────────────────────────────────────────────
```

If anything fails, the script exits with a `FAIL:` message and a non-zero exit code. Fix the reported issue and re-run.

---

## Operational commands

After a successful deploy, use `scripts/docker-services.sh` for day-to-day operations:

```bash
# Tail logs for all services (or a single one)
scripts/docker-services.sh logs staging-e2e-real
scripts/docker-services.sh logs staging-e2e-real gateway

# Re-check service health
scripts/docker-services.sh health staging-e2e-real

# Show running containers
scripts/docker-services.sh ps staging-e2e-real

# Stop and remove all containers (data volumes preserved)
scripts/docker-services.sh down staging-e2e-real
```

These commands read `.env.runtime` directly — no additional setup required.

---

## Re-deploying

| Scenario                                 | Command                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Code change (pull + deploy)              | `git pull && scripts/deploy.sh`                                         |
| Config change only (edit `.env.runtime`) | `scripts/deploy.sh --skip-build`                                        |
| Full teardown and fresh start            | `scripts/docker-services.sh down staging-e2e-real && scripts/deploy.sh` |

---

## Troubleshooting

**`FAIL: .env.runtime not found`**  
Run `cp .env.runtime.example .env.runtime` and fill in all values.

**`.env.runtime contains placeholder markers like <id> or <secret>.`**
Replace every placeholder marker with a real value before deploying.

**`FAIL: .env must not exist`**  
Remove the conflicting file: `rm .env`

**`FAIL: env validation passed for profile`** not printed  
`scripts/validate-env.sh` will print which specific variables are missing. Fix them in `.env.runtime`.

**A service is unhealthy after deploy**  
The gate script prints diagnostics (container state, health check log, tail of service logs) for the failing service. Check the output for the service name and last log lines.

**Indexer lag too high**  
The indexer needs time to sync. Increase `STAGING_E2E_REAL_LAG_WARMUP_SECONDS` in `.env.runtime` for slower networks, or check that `INDEXER_RPC_ENDPOINT` is reachable and not rate-limited.

---

## Related

- `.env.runtime.example` — canonical list of every configuration field
- `docs/runbooks/secrets-and-token-rotation.md` — rotating keys and API secrets
- `docs/runbooks/staging-e2e-real-release-gate.md` — what the gate validates
- `docs/runbooks/postgres-backup-restore-recovery.md` — database backup procedure
