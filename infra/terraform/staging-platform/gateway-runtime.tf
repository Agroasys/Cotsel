locals {
  postgres_host = split(":", local.postgres_endpoint)[0]

  gateway_environment = [
    { name = "AWS_REGION", value = var.region },
    { name = "DB_HOST", value = local.postgres_host },
    { name = "DB_NAME", value = "cotsel_gateway" },
    { name = "DB_PORT", value = "5432" },
    { name = "GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH", value = "true" },
    { name = "GATEWAY_AUTH_BASE_URL", value = "http://127.0.0.1:3005" },
    { name = "GATEWAY_COMMIT_SHA", value = var.gateway_image_tag },
    { name = "GATEWAY_CONTRACT_ADDRESS_REQUIRED", value = "false" },
    { name = "GATEWAY_CORS_ALLOWED_ORIGINS", value = "https://agroasys.com,https://app.agroasys.com" },
    { name = "GATEWAY_ENABLE_MUTATIONS", value = "false" },
    { name = "GATEWAY_GASLESS_EXECUTION_ENABLED", value = "false" },
    { name = "GATEWAY_INDEXER_GRAPHQL_URL", value = "http://127.0.0.1:4350/graphql" },
    { name = "GATEWAY_RATE_LIMIT_ENABLED", value = "false" },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_ENABLED", value = "true" },
    { name = "GATEWAY_SETTLEMENT_CALLBACK_URL", value = "https://backend.agroasys.com/api/v1/settlement-handoffs/cotsel/callbacks/execution-events" },
    { name = "GATEWAY_SETTLEMENT_INGRESS_ENABLED", value = "true" },
    { name = "GATEWAY_SETTLEMENT_RUNTIME", value = "base-sepolia" },
    { name = "GATEWAY_SETTLEMENT_SERVICE_AUTH_MAX_SKEW_SECONDS", value = "300" },
    { name = "GATEWAY_SETTLEMENT_SERVICE_AUTH_NONCE_TTL_SECONDS", value = "600" },
    { name = "NODE_ENV", value = "staging" },
    { name = "PORT", value = "3600" },
  ]

  gateway_secrets = [
    {
      name      = "DB_MIGRATION_PASSWORD"
      valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/migration"].arn}:password::"
    },
    {
      name      = "DB_MIGRATION_USER"
      valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/migration"].arn}:username::"
    },
    {
      name      = "DB_PASSWORD"
      valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/runtime"].arn}:password::"
    },
    {
      name      = "DB_USER"
      valueFrom = "${aws_secretsmanager_secret.platform["database/gateway/runtime"].arn}:username::"
    },
    {
      name      = "GATEWAY_SETTLEMENT_CALLBACK_API_KEY"
      valueFrom = "${aws_secretsmanager_secret.platform["gateway-settlement-callback"].arn}:id::"
    },
    {
      name      = "GATEWAY_SETTLEMENT_CALLBACK_API_SECRET"
      valueFrom = "${aws_secretsmanager_secret.platform["gateway-settlement-callback"].arn}:secret::"
    },
    {
      name      = "GATEWAY_SETTLEMENT_SERVICE_API_KEYS_JSON"
      valueFrom = aws_secretsmanager_secret.platform["gateway-settlement-ingress"].arn
    },
  ]
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${local.name_prefix}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.gateway_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = "${aws_ecr_repository.service["gateway"].repository_url}:${var.gateway_image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = 3600
          hostPort      = 3600
          protocol      = "tcp"
        },
      ]

      environment = local.gateway_environment
      secrets     = local.gateway_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["gateway"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "gateway" {
  name                               = "${local.name_prefix}-gateway"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.gateway.arn
  desired_count                      = var.gateway_desired_count
  launch_type                        = "FARGATE"
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 120

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.gateway.id,
      local.data_client_sg_id,
    ]
    subnets = local.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 3600
  }

  depends_on = [
    aws_iam_role_policy.gateway_execution,
    aws_lb_listener.gateway,
  ]
}
