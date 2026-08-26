locals {
  base_sepolia_chain_id     = 84532
  base_sepolia_explorer_url = "https://sepolia.basescan.org"

  oracle_environment = [
    { name = "CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_AUTO_MIGRATE", value = "false" },
    { name = "DB_NAME", value = "cotsel_oracle" },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_SSL_MODE", value = "verify-full" },
    { name = "ESCROW_ADDRESS", value = var.base_sepolia_escrow_address },
    { name = "EXPLORER_BASE_URL", value = local.base_sepolia_explorer_url },
    { name = "HMAC_NONCE_TTL_SECONDS", value = "600" },
    { name = "INDEXER_GQL_TIMEOUT_MS", value = "10000" },
    { name = "INDEXER_GRAPHQL_URL", value = "http://127.0.0.1:4350/graphql" },
    { name = "NODE_ENV", value = "staging" },
    { name = "NOTIFICATIONS_COOLDOWN_MS", value = "300000" },
    { name = "NOTIFICATIONS_ENABLED", value = "false" },
    { name = "NOTIFICATIONS_REQUEST_TIMEOUT_MS", value = "5000" },
    { name = "ORACLE_MANUAL_APPROVAL_ENABLED", value = "false" },
    { name = "ORACLE_RATE_LIMIT_ENABLED", value = "false" },
    { name = "ORACLE_SIGNER_CUSTODY_MODE", value = "raw_private_key" },
    { name = "PGSSLMODE", value = "verify-full" },
    { name = "PORT", value = "3001" },
    { name = "RETRY_ATTEMPTS", value = "3" },
    { name = "RETRY_DELAY", value = "1000" },
    { name = "SETTLEMENT_RUNTIME", value = "base-sepolia" },
    { name = "USDC_ADDRESS", value = var.base_sepolia_usdc_address },
  ]

  oracle_secrets = [
    { name = "API_KEY", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-oracle-auth"].arn}:id::" },
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/oracle/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/oracle/runtime"].arn}:username::" },
    { name = "HMAC_SECRET", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-oracle-auth"].arn}:secret::" },
    { name = "ORACLE_PRIVATE_KEY", valueFrom = "${data.aws_secretsmanager_secret.oracle_wallet.arn}:privateKey::" },
    { name = "RPC_FALLBACK_URLS", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn },
    { name = "RPC_URL", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn },
  ]

  oracle_container = {
    name                   = "oracle"
    image                  = local.runtime_images["oracle"]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "oracle-tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = [{ containerPort = 3001, hostPort = 3001, protocol = "tcp" }]
    environment            = local.oracle_environment
    secrets                = local.oracle_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'const p=process.env.PORT||3001;fetch(\"http://127.0.0.1:\"+p+\"/api/oracle/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 45
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["oracle"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "oracle"
      }
    }
  }

  reconciliation_environment = [
    { name = "CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_AUTO_MIGRATE", value = "false" },
    { name = "DB_NAME", value = "cotsel_reconciliation" },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_SSL_MODE", value = "verify-full" },
    { name = "ESCROW_ADDRESS", value = var.base_sepolia_escrow_address },
    { name = "EXPLORER_BASE_URL", value = local.base_sepolia_explorer_url },
    { name = "INDEXER_GQL_TIMEOUT_MS", value = "10000" },
    { name = "INDEXER_GRAPHQL_URL", value = "http://127.0.0.1:4350/graphql" },
    { name = "NODE_ENV", value = "staging" },
    { name = "NOTIFICATIONS_COOLDOWN_MS", value = "300000" },
    { name = "NOTIFICATIONS_ENABLED", value = "false" },
    { name = "NOTIFICATIONS_REQUEST_TIMEOUT_MS", value = "5000" },
    { name = "PGSSLMODE", value = "verify-full" },
    { name = "RECONCILIATION_BATCH_SIZE", value = "100" },
    { name = "RECONCILIATION_DAEMON_INTERVAL_MS", value = "60000" },
    { name = "RECONCILIATION_ENABLED", value = "true" },
    { name = "RECONCILIATION_HEALTH_PORT", value = "9090" },
    { name = "RECONCILIATION_MAX_TRADES_PER_RUN", value = "1000" },
    { name = "RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL", value = "false" },
    { name = "SETTLEMENT_RUNTIME", value = "base-sepolia" },
    { name = "USDC_ADDRESS", value = var.base_sepolia_usdc_address },
  ]

  reconciliation_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/reconciliation/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/reconciliation/runtime"].arn}:username::" },
    { name = "RPC_FALLBACK_URLS", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn },
    { name = "RPC_URL", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn },
  ]

  reconciliation_container = {
    name                   = "reconciliation"
    image                  = local.runtime_images["reconciliation"]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "reconciliation-tmp", containerPath = "/tmp", readOnly = false }]
    command                = ["node", "reconciliation/dist/cli.js", "daemon"]
    portMappings           = [{ containerPort = 9090, hostPort = 9090, protocol = "tcp" }]
    environment            = local.reconciliation_environment
    secrets                = local.reconciliation_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'const p=process.env.RECONCILIATION_HEALTH_PORT||9090;fetch(\"http://127.0.0.1:\"+p+\"/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 45
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["reconciliation"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "reconciliation"
      }
    }
  }
}
