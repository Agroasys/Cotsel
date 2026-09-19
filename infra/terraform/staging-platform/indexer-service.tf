locals {
  indexer_reviewed_config_sha256 = sha256(jsonencode([
    {
      name              = local.indexer_pipeline_container.name
      environment       = local.indexer_pipeline_environment
      secret_references = local.indexer_pipeline_secrets
    },
    {
      name              = local.indexer_graphql_container.name
      environment       = local.indexer_graphql_environment
      secret_references = local.indexer_graphql_secrets
    },
  ]))
}

resource "aws_iam_role" "indexer_execution" {
  name                 = "${local.name_prefix}-indexer-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "indexer"
  }
}

resource "aws_iam_role" "indexer_task" {
  name                 = "${local.name_prefix}-indexer-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "indexer"
  }
}

data "aws_iam_policy_document" "indexer_execution" {
  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullIndexerRuntimeImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [
      aws_ecr_repository.service["indexer-graphql"].arn,
      aws_ecr_repository.service["indexer-pipeline"].arn,
    ]
  }

  statement {
    sid    = "WriteIndexerLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.service["indexer-graphql"].arn}:*",
      "${aws_cloudwatch_log_group.service["indexer-pipeline"].arn}:*",
    ]
  }

  statement {
    sid     = "ReadIndexerStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.platform["database/indexer/reader"].arn,
      aws_secretsmanager_secret.platform["database/indexer/runtime"].arn,
      aws_secretsmanager_secret.platform["notifications-webhook"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn,
    ]
  }

  statement {
    sid       = "DecryptIndexerStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "indexer_execution" {
  name   = "${local.name_prefix}-indexer-execution"
  role   = aws_iam_role.indexer_execution.id
  policy = data.aws_iam_policy_document.indexer_execution.json
}

resource "aws_ecs_task_definition" "indexer" {
  family                   = "${local.name_prefix}-indexer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.indexer_execution.arn
  task_role_arn            = aws_iam_role.indexer_task.arn
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "indexer-pipeline-tmp"
  }

  volume {
    name = "indexer-graphql-tmp"
  }

  container_definitions = jsonencode([
    local.indexer_pipeline_container,
    local.indexer_graphql_container,
  ])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.indexer_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "indexer" {
  name                               = "${local.name_prefix}-indexer"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.indexer.arn
  desired_count                      = var.indexer_desired_count
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 120

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
    registry_arn = aws_service_discovery_service.runtime["indexer-graphql"].arn
  }

  depends_on = [aws_iam_role_policy.indexer_execution]
}
