locals {
  indexer_pipeline_environment = [
    { name = "CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
    { name = "CONTRACT_ADDRESS", value = var.base_sepolia_escrow_address },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_NAME", value = "cotsel_indexer" },
    { name = "DB_PORT", value = "5432" },
    { name = "FINALITY_CONFIRMATION_BLOCKS", value = "1" },
    { name = "GRAPHQL_PORT", value = "4350" },
    { name = "PGSSLMODE", value = "verify-full" },
    { name = "RATE_LIMIT", value = "10" },
    { name = "RPC_CAPACITY", value = "1" },
    { name = "RPC_MAX_BATCH_CALL_SIZE", value = "1" },
    { name = "RPC_REQUEST_TIMEOUT_MS", value = "10000" },
    { name = "RPC_RETRY_ATTEMPTS", value = "5" },
    { name = "START_BLOCK", value = tostring(var.base_sepolia_contract_start_block) },
    { name = "SUBSQUID_EVM_RPC_SPLIT_SIZE", value = "10" },
  ]

  indexer_pipeline_secrets = [
    { name = "DB_PASS", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:password::" },
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:username::" },
    { name = "RPC_ENDPOINT", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn },
    { name = "RPC_FALLBACK_ENDPOINTS", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn },
  ]

  indexer_pipeline_container = {
    name        = "indexer-pipeline"
    image       = local.runtime_images["indexer-pipeline"]
    essential   = true
    environment = local.indexer_pipeline_environment
    secrets     = local.indexer_pipeline_secrets
    restartPolicy = {
      enabled              = true
      restartAttemptPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["indexer-pipeline"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }

  indexer_graphql_environment = [
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_NAME", value = "cotsel_indexer" },
    { name = "DB_PORT", value = "5432" },
    { name = "GQL_PORT", value = "4350" },
    { name = "PGSSLMODE", value = "verify-full" },
  ]

  indexer_graphql_secrets = [
    { name = "DB_PASS", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:password::" },
    { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:password::" },
    { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/runtime"].arn}:username::" },
  ]

  indexer_graphql_container = {
    name             = "indexer-graphql"
    image            = local.runtime_images["indexer-graphql"]
    essential        = true
    workingDirectory = "/app/indexer"
    command          = ["node", "node_modules/@subsquid/graphql-server/bin/run.js", "--no-squid-status"]
    portMappings     = [{ containerPort = 4350, hostPort = 4350, protocol = "tcp" }]
    environment      = local.indexer_graphql_environment
    secrets          = local.indexer_graphql_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"const p=process.env.GQL_PORT||4350;fetch(\\\"http://127.0.0.1:\\\"+p+\\\"/graphql\\\",{method:\\\"POST\\\",headers:{\\\"Content-Type\\\":\\\"application/json\\\"},body:JSON.stringify({query:\\\"{ __typename }\\\"})}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["indexer-graphql"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }
}
