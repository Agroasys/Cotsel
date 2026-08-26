locals {
  gateway_environment = [
    { name = "AWS_REGION", value = var.region },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_AUTO_MIGRATE", value = "false" },
    { name = "DB_NAME", value = "cotsel_gateway" },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_SSL_MODE", value = "verify-full" },
    { name = "GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH", value = "false" },
    { name = "GATEWAY_AUTH_BASE_URL", value = "http://127.0.0.1:3005" },
    { name = "GATEWAY_CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
    { name = "GATEWAY_COMMIT_SHA", value = var.gateway_image_tag },
    { name = "GATEWAY_CONTRACT_ADDRESS_REQUIRED", value = "true" },
    { name = "GATEWAY_CORS_ALLOWED_ORIGINS", value = "https://agroasys.com,https://app.agroasys.com" },
    { name = "GATEWAY_ENABLE_MUTATIONS", value = "false" },
    { name = "GATEWAY_ESCROW_ADDRESS", value = var.base_sepolia_escrow_address },
    { name = "GATEWAY_EXPLORER_BASE_URL", value = local.base_sepolia_explorer_url },
    { name = "GATEWAY_GASLESS_EXECUTION_ENABLED", value = "false" },
    { name = "GATEWAY_INDEXER_GRAPHQL_URL", value = "http://127.0.0.1:4350/graphql" },
    { name = "GATEWAY_ORACLE_BASE_URL", value = "http://127.0.0.1:3001" },
    { name = "GATEWAY_RATE_LIMIT_ENABLED", value = "false" },
    { name = "GATEWAY_RECONCILIATION_BASE_URL", value = "http://127.0.0.1:9090" },
    { name = "GATEWAY_RICARDIAN_BASE_URL", value = "http://ricardian.cotsel-staging.internal:3100" },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_ENABLED", value = "true" },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_URL", value = var.backend_settlement_callback_url },
    { name = "GATEWAY_SETTLEMENT_INGRESS_ENABLED", value = "true" },
    { name = "GATEWAY_SETTLEMENT_RUNTIME", value = "base-sepolia" },
    { name = "GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS", value = "300" },
    { name = "GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS", value = "600" },
    { name = "GATEWAY_TREASURY_BASE_URL", value = "http://treasury.cotsel-staging.internal:3200" },
    { name = "GATEWAY_USDC_ADDRESS", value = var.base_sepolia_usdc_address },
    { name = "NODE_ENV", value = "staging" },
    { name = "PORT", value = "3600" },
  ]

  gateway_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/runtime"].arn}:username::" },
    { name = "GATEWAY_ORACLE_SERVICE_API_KEY", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-oracle-auth"].arn}:id::" },
    { name = "GATEWAY_ORACLE_SERVICE_API_SECRET", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-oracle-auth"].arn}:secret::" },
    { name = "GATEWAY_RICARDIAN_SERVICE_API_KEY", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn}:id::" },
    { name = "GATEWAY_RICARDIAN_SERVICE_API_SECRET", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn}:secret::" },
    { name = "GATEWAY_RPC_FALLBACK_URLS", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn },
    { name = "GATEWAY_RPC_URL", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_API_KEY", valueFrom = "${aws_secretsmanager_secret.platform["gateway-settlement-callback"].arn}:id::" },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_API_SECRET", valueFrom = "${aws_secretsmanager_secret.platform["gateway-settlement-callback"].arn}:secret::" },
    { name = "GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-settlement-ingress"].arn },
    { name = "GATEWAY_TREASURY_SERVICE_API_KEY", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn}:id::" },
    { name = "GATEWAY_TREASURY_SERVICE_API_SECRET", valueFrom = "${aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn}:secret::" },
  ]

  gateway_container = {
    name                   = "gateway"
    image                  = local.runtime_images["gateway"]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "gateway-tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = [{ containerPort = 3600, hostPort = 3600, protocol = "tcp" }]
    environment            = local.gateway_environment
    secrets                = local.gateway_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["gateway"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }

  auth_environment = [
    { name = "AUTH_ADMIN_CONTROL_ENABLED", value = "false" },
    { name = "AUTH_CORS_ALLOWED_ORIGINS", value = "https://agroasys.com,https://app.agroasys.com" },
    { name = "AUTH_CORS_ALLOW_NO_ORIGIN", value = "false" },
    { name = "AUTH_RATE_LIMIT_ENABLED", value = "false" },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_AUTO_MIGRATE", value = "false" },
    { name = "DB_NAME", value = "cotsel_auth" },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_SSL_MODE", value = "verify-full" },
    { name = "NODE_ENV", value = "staging" },
    { name = "PGSSLMODE", value = "verify-full" },
    { name = "PORT", value = "3005" },
    { name = "SESSION_TTL_SECONDS", value = "3600" },
    { name = "TRUSTED_SESSION_EXCHANGE_ENABLED", value = "false" },
    { name = "TRUSTED_SESSION_EXCHANGE_MAX_SKEW_SECONDS", value = "300" },
    { name = "TRUSTED_SESSION_EXCHANGE_NONCE_TTL_SECONDS", value = "600" },
  ]

  auth_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/auth/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/auth/runtime"].arn}:username::" },
  ]

  auth_container = {
    name                   = "auth"
    image                  = local.runtime_images["auth"]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "auth-tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = [{ containerPort = 3005, hostPort = 3005, protocol = "tcp" }]
    environment            = local.auth_environment
    secrets                = local.auth_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"const p=process.env.PORT||3005;fetch(\\\"http://127.0.0.1:\\\"+p+\\\"/api/auth/v1/health\\\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["auth"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }
}
