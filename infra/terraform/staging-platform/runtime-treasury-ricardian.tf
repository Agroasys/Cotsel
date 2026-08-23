locals {
  private_runtime_services = {
    ricardian = {
      container_port = 3100
      desired_count  = var.ricardian_desired_count
      db_name        = "cotsel_ricardian"
      health_path    = "/api/ricardian/v1/health"
      log_prefix     = "ricardian"
      secret_arns = [
        aws_secretsmanager_secret.platform["database/ricardian/migration"].arn,
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
      secret_arns = [
        aws_secretsmanager_secret.platform["database/treasury/migration"].arn,
        aws_secretsmanager_secret.platform["database/treasury/runtime"].arn,
        aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn,
      ]
    }
  }

  private_runtime_environment = {
    ricardian = [
      { name = "AUTH_ENABLED", value = "true" },
      { name = "AUTH_MAX_SKEW_SECONDS", value = "300" },
      { name = "AUTH_NONCE_TTL_SECONDS", value = "600" },
      { name = "DB_HOST", value = local.postgres_host },
      { name = "DB_NAME", value = local.private_runtime_services.ricardian.db_name },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_SSL_MODE", value = "verify-full" },
      { name = "NODE_ENV", value = "staging" },
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
      { name = "DB_HOST", value = local.postgres_host },
      { name = "DB_NAME", value = local.private_runtime_services.treasury.db_name },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_SSL_MODE", value = "verify-full" },
      { name = "INDEXER_GRAPHQL_URL", value = "http://indexer-graphql.cotsel-staging.internal:4350/graphql" },
      { name = "NODE_ENV", value = "staging" },
      { name = "NONCE_STORE", value = "postgres" },
      { name = "NONCE_TTL_SECONDS", value = "600" },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PORT", value = "3200" },
      { name = "RATE_LIMIT_ENABLED", value = "true" },
      { name = "RATE_LIMIT_FAIL_OPEN", value = "false" },
      { name = "RATE_LIMIT_REDIS_URL", value = "rediss://${local.redis_primary_endpoint}:6379" },
      { name = "TREASURY_INGEST_BATCH_SIZE", value = "100" },
      { name = "TREASURY_INGEST_MAX_EVENTS", value = "2000" },
    ]
  }

  private_runtime_secrets = {
    ricardian = [
      { name = "API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn },
      { name = "DB_MIGRATION_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/migration"].arn}:password::" },
      { name = "DB_MIGRATION_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/migration"].arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn}:password::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn}:username::" },
    ]
    treasury = [
      { name = "API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn },
      { name = "DB_MIGRATION_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/migration"].arn}:password::" },
      { name = "DB_MIGRATION_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/migration"].arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/runtime"].arn}:password::" },
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/treasury/runtime"].arn}:username::" },
    ]
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

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name         = each.key
      image        = local.runtime_images[each.key]
      essential    = true
      environment  = local.private_runtime_environment[each.key]
      secrets      = local.private_runtime_secrets[each.key]
      portMappings = [{ containerPort = each.value.container_port, hostPort = each.value.container_port, protocol = "tcp" }]
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
