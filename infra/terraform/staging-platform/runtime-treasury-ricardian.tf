locals {
  # WP-4 FAIL-11 and COMP-06. Provider completion evidence is only worth its
  # provenance, so treasury verifies every callback signature. The secret
  # identity always exists; the task references it only once a value has been
  # written, because an unresolvable secret reference fails task startup.
  treasury_provider_callbacks_enabled = var.treasury_provider_callback_secret_populated

  private_runtime_services = {
    ricardian = {
      container_port = 3100
      desired_count  = var.ricardian_desired_count
      db_name        = "cotsel_ricardian"
      health_path    = "/api/ricardian/v1/health"
      log_prefix     = "ricardian"
      secret_arns = [
        aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn,
        aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn,
      ]
    }
    treasury = {
      container_port = 3200
      desired_count  = var.treasury_desired_count
      db_name        = "cotsel_treasury"
      health_path    = "/api/treasury/v1/health"
      log_prefix     = "treasury"
      secret_arns = concat([
        aws_secretsmanager_secret.platform["database/treasury/runtime"].arn,
        aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn,
        aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn,
        aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn,
        # WP-4 H-25. Read-only reconciliation identity. Treasury must be able to
        # ask which chain range an accepted run covered; it must never be able to
        # write, clear or age the evidence that gates its own realization.
        local.foundation_secret_arns["database/reconciliation/reader"],
        ], local.treasury_provider_callbacks_enabled ? [
        aws_secretsmanager_secret.platform["treasury-provider-callback"].arn,
      ] : [])
    }
  }

  private_runtime_environment = {
    ricardian = [
      { name = "AUTH_ENABLED", value = "true" },
      { name = "AUTH_MAX_SKEW_SECONDS", value = "300" },
      { name = "AUTH_NONCE_TTL_SECONDS", value = "600" },
      { name = "COTSEL_ENVIRONMENT", value = "staging" },
      { name = "DB_HOST", value = local.postgres_host },
      { name = "DB_NAME", value = local.private_runtime_services.ricardian.db_name },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_SSL_MODE", value = "verify-full" },
      { name = "NODE_ENV", value = "production" },
      { name = "NONCE_STORE", value = "postgres" },
      { name = "NONCE_TTL_SECONDS", value = "600" },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PORT", value = "3100" },
      { name = "RATE_LIMIT_ENABLED", value = "false" },
    ]
    treasury = [
      { name = "AUTH_ENABLED", value = "true" },
      { name = "AUTH_MAX_SKEW_SECONDS", value = "300" },
      { name = "AUTH_NONCE_TTL_SECONDS", value = "600" },
      { name = "CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
      { name = "COTSEL_ENVIRONMENT", value = "staging" },
      { name = "DB_HOST", value = local.postgres_host },
      { name = "DB_NAME", value = local.private_runtime_services.treasury.db_name },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_SSL_MODE", value = "verify-full" },
      { name = "EXPLORER_BASE_URL", value = local.base_sepolia_explorer_url },
      { name = "INDEXER_GRAPHQL_URL", value = "http://indexer-graphql.cotsel-staging.internal:4350/graphql" },
      { name = "NODE_ENV", value = "production" },
      { name = "NONCE_STORE", value = "postgres" },
      { name = "NONCE_TTL_SECONDS", value = "600" },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PORT", value = "3200" },
      { name = "RATE_LIMIT_ENABLED", value = "true" },
      { name = "RATE_LIMIT_FAIL_OPEN", value = "false" },
      { name = "RATE_LIMIT_REDIS_URL", value = "rediss://${local.redis_primary_endpoint}:6379" },
      # WP-4 H-25. Realization and close read the accepted reconciliation run
      # through a dedicated reader role. Without this database the gate returns
      # UNKNOWN and blocks, which is safe but unprovable.
      { name = "RECONCILIATION_DB_HOST", value = local.postgres_host },
      { name = "RECONCILIATION_DB_NAME", value = "cotsel_reconciliation" },
      { name = "RECONCILIATION_DB_PORT", value = "5432" },
      { name = "RECONCILIATION_DB_SSL_MODE", value = "verify-full" },
      { name = "RECONCILIATION_MAX_AGE_SECONDS", value = "900" },
      { name = "RECONCILIATION_MAX_RUNNING_RUN_AGE_SECONDS", value = "900" },
      # WP-4 FAIL-06. Canonicality decides payout eligibility, so no single RPC
      # provider may answer for the chain alone. The SDK clamps this to the
      # number of configured endpoints, so a degraded fallback set cannot take
      # the service down.
      { name = "RPC_QUORUM", value = "2" },
      { name = "SETTLEMENT_RUNTIME", value = "base-sepolia" },
      # WP-4 B-09 and FAIL-10. The worker is the only thing that advances chain
      # evidence on a schedule. The freshness threshold must exceed the interval
      # or export could never open; treasury asserts that relationship at boot.
      { name = "TREASURY_INGESTION_WORKER_ENABLED", value = "true" },
      { name = "TREASURY_INGEST_BATCH_SIZE", value = "100" },
      { name = "TREASURY_INGEST_INTERVAL_MS", value = "60000" },
      { name = "TREASURY_INGEST_MAX_AGE_SECONDS", value = "900" },
      { name = "TREASURY_INGEST_MAX_EVENTS", value = "2000" },
      { name = "TREASURY_INGEST_MAX_LAG_BLOCKS", value = "300" },
      # WP-4 H-16 and PRES-05. Treasury's operator traffic arrives from the
      # dashboard gateway under its own service key, so that one caller may name
      # the operator it authenticated. This is a separation-of-duty exception and
      # therefore belongs in reviewed configuration, not in a secret: the
      # identifier is not a credential, and the reviewed config digest has to
      # cover which caller holds the exception.
      { name = "TREASURY_OPERATOR_DELEGATION_API_KEYS", value = var.treasury_gateway_api_key_id },
      { name = "TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED", value = "true" },
      { name = "TREASURY_PROVIDER_CALLBACK_MAX_SKEW_SECONDS", value = "300" },
    ]
  }

  private_runtime_secrets = {
    ricardian = [
      { name = "API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn}:password::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn}:username::" },
    ]
    treasury = concat([
      { name = "API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/runtime"].arn}:password::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/runtime"].arn}:username::" },
      { name = "RECONCILIATION_DB_PASSWORD", valueFrom = "${local.foundation_secret_arns["database/reconciliation/reader"]}:password::" },
      { name = "RECONCILIATION_DB_USER", valueFrom = "${local.foundation_secret_arns["database/reconciliation/reader"]}:username::" },
      { name = "RPC_FALLBACK_URLS", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn },
      { name = "RPC_URL", valueFrom = aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn },
      ], local.treasury_provider_callbacks_enabled ? [
      { name = "TREASURY_PROVIDER_WEBHOOK_SECRETS_JSON", valueFrom = aws_secretsmanager_secret.platform["treasury-provider-callback"].arn },
    ] : [])
  }

  private_runtime_reviewed_config_sha256 = {
    for service in keys(local.private_runtime_services) : service => sha256(jsonencode({
      environment       = local.private_runtime_environment[service]
      secret_references = local.private_runtime_secrets[service]
    }))
  }
}

resource "aws_iam_role" "private_runtime_execution" {
  for_each = local.private_runtime_services

  name                 = "${local.name_prefix}-${each.key}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = each.key
  }
}

data "aws_iam_policy_document" "private_runtime_execution" {
  for_each = local.private_runtime_services

  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullServiceRuntimeImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.service[each.key].arn]
  }

  statement {
    sid    = "WriteServiceLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service[each.key].arn}:*"]
  }

  statement {
    sid       = "ReadServiceStartupSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value.secret_arns
  }

  statement {
    sid       = "DecryptServiceStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "private_runtime_execution" {
  for_each = local.private_runtime_services

  name   = "${local.name_prefix}-${each.key}-execution"
  role   = aws_iam_role.private_runtime_execution[each.key].id
  policy = data.aws_iam_policy_document.private_runtime_execution[each.key].json
}

resource "aws_iam_role" "private_runtime_task" {
  for_each = local.private_runtime_services

  name                 = "${local.name_prefix}-${each.key}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = each.key
  }
}

resource "aws_ecs_task_definition" "private_runtime" {
  for_each = local.private_runtime_services

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.private_runtime_execution[each.key].arn
  task_role_arn            = aws_iam_role.private_runtime_task[each.key].arn
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = each.key
      image                  = local.runtime_images[each.key]
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      environment            = local.private_runtime_environment[each.key]
      secrets                = local.private_runtime_secrets[each.key]
      portMappings           = [{ containerPort = each.value.container_port, hostPort = each.value.container_port, protocol = "tcp" }]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e 'const p=process.env.PORT||${each.value.container_port};fetch(\"http://127.0.0.1:\"+p+\"${each.value.health_path}\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.value.log_prefix
        }
      }
    },
  ])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.private_runtime_reviewed_config_sha256[each.key]
  }
}

resource "aws_ecs_service" "private_runtime" {
  for_each = local.private_runtime_services

  name                               = "${local.name_prefix}-${each.key}"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.private_runtime[each.key].arn
  desired_count                      = each.value.desired_count
  launch_type                        = "FARGATE"
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.internal_services.id,
      local.data_client_sg_id,
    ]
    subnets = local.private_subnet_ids
  }

  service_registries {
    # runtime uses an A record. ECS derives the task address from awsvpc mode;
    # container_name and container_port are valid only for SRV registrations.
    registry_arn = aws_service_discovery_service.runtime[each.key].arn
  }

  depends_on = [
    aws_iam_role_policy.private_runtime_execution,
  ]
}
