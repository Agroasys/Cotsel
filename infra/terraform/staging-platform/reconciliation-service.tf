locals {
  reconciliation_reviewed_config_sha256 = sha256(jsonencode({
    environment       = local.reconciliation_environment
    secret_references = local.reconciliation_secrets
    task_role_arn     = aws_iam_role.reconciliation_task.arn
  }))
}

resource "aws_iam_role" "reconciliation_execution" {
  name                 = "${local.name_prefix}-reconciliation-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "reconciliation"
  }
}

resource "aws_iam_role" "reconciliation_task" {
  name                 = "${local.name_prefix}-reconciliation-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "reconciliation"
  }
}

data "aws_iam_policy_document" "reconciliation_execution" {
  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullReconciliationRuntimeImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.service["reconciliation"].arn]
  }

  statement {
    sid    = "WriteReconciliationLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service["reconciliation"].arn}:*"]
  }

  statement {
    sid     = "ReadReconciliationStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.platform["database/reconciliation/runtime"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn,
    ]
  }

  statement {
    sid       = "DecryptReconciliationStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "reconciliation_execution" {
  name   = "${local.name_prefix}-reconciliation-execution"
  role   = aws_iam_role.reconciliation_execution.id
  policy = data.aws_iam_policy_document.reconciliation_execution.json
}

resource "aws_ecs_task_definition" "reconciliation" {
  family                   = "${local.name_prefix}-reconciliation"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.reconciliation_execution.arn
  task_role_arn            = aws_iam_role.reconciliation_task.arn
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "reconciliation-tmp"
  }

  container_definitions = jsonencode([local.reconciliation_container])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.reconciliation_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "reconciliation" {
  name                               = "${local.name_prefix}-reconciliation"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.reconciliation.arn
  desired_count                      = var.reconciliation_desired_count
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
    registry_arn = aws_service_discovery_service.runtime["reconciliation"].arn
  }

  depends_on = [
    aws_ecs_service.indexer,
    aws_iam_role_policy.reconciliation_execution,
  ]
}
