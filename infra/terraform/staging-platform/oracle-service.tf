locals {
  oracle_reviewed_config_sha256 = sha256(jsonencode({
    environment       = local.oracle_environment
    secret_references = local.oracle_secrets
    task_role_arn     = local.managed_signer_task_role_arns["oracle"]
  }))
}

check "oracle_activation_requires_reviewed_kms_address" {
  assert {
    condition     = var.oracle_desired_count == 0 || local.oracle_kms_enabled
    error_message = "Oracle activation requires the independently reviewed KMS address."
  }
}

data "aws_iam_policy_document" "oracle_kms_signing" {
  count = local.oracle_kms_enabled ? 1 : 0

  statement {
    sid       = "ReadOracleSignerPublicKey"
    effect    = "Allow"
    actions   = ["kms:GetPublicKey"]
    resources = [local.managed_signer_key_arns["oracle"]]
  }

  statement {
    sid       = "SignOracleTransactionDigests"
    effect    = "Allow"
    actions   = ["kms:Sign"]
    resources = [local.managed_signer_key_arns["oracle"]]

    condition {
      test     = "StringEquals"
      variable = "kms:MessageType"
      values   = ["DIGEST"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }
  }
}

resource "aws_iam_role_policy" "oracle_kms_signing" {
  count = local.oracle_kms_enabled ? 1 : 0

  name   = "${local.name_prefix}-oracle-kms-signing"
  role   = local.managed_signer_task_role_names["oracle"]
  policy = data.aws_iam_policy_document.oracle_kms_signing[0].json
}

resource "aws_ecs_task_definition" "oracle" {
  family                   = "${local.name_prefix}-oracle"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = data.terraform_remote_state.foundation.outputs.runtime_execution_role_arns["oracle"]
  task_role_arn            = local.managed_signer_task_role_arns["oracle"]
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "oracle-tmp"
  }

  container_definitions = jsonencode([local.oracle_container])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.oracle_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "oracle" {
  name            = "${local.name_prefix}-oracle"
  cluster         = aws_ecs_cluster.staging.id
  task_definition = aws_ecs_task_definition.oracle.arn
  # Plan A creates the non-exportable KMS key with no runnable Oracle task.
  # Plan B can enable one task only after its derived address is independently
  # verified and supplied through oracle_kms_expected_address.
  desired_count          = var.oracle_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false
  # Oracle can submit financial state transitions. Never overlap revisions:
  # remove the bundled worker first, then accept a bounded maintenance gap.
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
    registry_arn = data.terraform_remote_state.foundation.outputs.runtime_service_discovery_arns["oracle"]
  }

  depends_on = [
    aws_ecs_service.indexer,
    aws_iam_role_policy.oracle_kms_signing,
  ]
}
