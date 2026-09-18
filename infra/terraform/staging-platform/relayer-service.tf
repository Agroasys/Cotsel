locals {
  relayer_kms_enabled = var.relayer_kms_expected_address != ""
  relayer_environment = [
    { name = "AWS_REGION", value = var.region },
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3300" },
    { name = "RELAYER_AUTH_MAX_SKEW_SECONDS", value = "300" },
    { name = "RELAYER_AUTH_NONCE_TTL_SECONDS", value = "600" },
    { name = "RELAYER_CHAIN_ID", value = tostring(local.base_sepolia_chain_id) },
    { name = "RELAYER_ESCROW_ADDRESS", value = var.base_sepolia_escrow_address },
    { name = "RELAYER_KMS_EXPECTED_ADDRESS", value = var.relayer_kms_expected_address },
    { name = "RELAYER_KMS_KEY_ID", value = local.managed_signer_aliases["relayer"] },
    { name = "RELAYER_MAX_FEE_PER_GAS_WEI", value = "50000000000" },
    { name = "RELAYER_MAX_GAS_LIMIT", value = "1500000" },
    { name = "RELAYER_MAX_NATIVE_COST_WEI", value = "100000000000000000" },
    { name = "RELAYER_REDIS_URL", value = "rediss://${local.redis_primary_endpoint}:6379" },
    { name = "RELAYER_REQUEST_REPLAY_TTL_SECONDS", value = "900" },
    { name = "RELAYER_SIGNER_CUSTODY_MODE", value = "kms" },
    { name = "RELAYER_USDC_ADDRESS", value = var.base_sepolia_usdc_address },
  ]
  relayer_secrets = [
    { name = "RELAYER_API_KEYS_JSON", valueFrom = aws_secretsmanager_secret.platform["gateway-managed-signer"].arn },
  ]
  relayer_container = {
    name                   = "relayer"
    image                  = local.runtime_images["relayer"]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "relayer-tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = [{ containerPort = 3300, hostPort = 3300, protocol = "tcp" }]
    environment            = local.relayer_environment
    secrets                = local.relayer_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:3300/api/relayer/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["relayer"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "relayer"
      }
    }
  }
  relayer_reviewed_config_sha256 = sha256(jsonencode({
    environment       = local.relayer_environment
    secret_references = local.relayer_secrets
    task_role_arn     = local.managed_signer_task_role_arns["relayer"]
  }))
}

check "gasless_execution_has_one_gateway_writer" {
  assert {
    condition     = !var.gasless_execution_enabled || (local.relayer_kms_enabled && var.gateway_desired_count == 1)
    error_message = "Gasless execution requires an attested relayer address and exactly one gateway writer until multi-writer runtime evidence is accepted."
  }
}

resource "aws_iam_role" "relayer_execution" {
  name                 = "${local.name_prefix}-relayer-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn
  tags                 = { Environment = var.environment, Service = "relayer" }
}

data "aws_iam_policy_document" "relayer_execution" {
  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid    = "PullRelayerRuntimeImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.terraform_remote_state.foundation.outputs.ecr_repository_arns["relayer"]]
  }
  statement {
    sid       = "WriteRelayerLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.service["relayer"].arn}:*"]
  }
  statement {
    sid       = "ReadRelayerStartupSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.platform["gateway-managed-signer"].arn]
  }
  statement {
    sid       = "DecryptRelayerStartupSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "relayer_execution" {
  name   = "${local.name_prefix}-relayer-execution"
  role   = aws_iam_role.relayer_execution.id
  policy = data.aws_iam_policy_document.relayer_execution.json
}

data "aws_iam_policy_document" "relayer_kms_signing" {
  count = local.relayer_kms_enabled ? 1 : 0

  statement {
    sid       = "ReadRelayerSignerPublicKey"
    effect    = "Allow"
    actions   = ["kms:GetPublicKey"]
    resources = [local.managed_signer_key_arns["relayer"]]
  }

  statement {
    sid       = "SignGaslessTransactionDigests"
    effect    = "Allow"
    actions   = ["kms:Sign"]
    resources = [local.managed_signer_key_arns["relayer"]]

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

resource "aws_iam_role_policy" "relayer_kms_signing" {
  count  = local.relayer_kms_enabled ? 1 : 0
  name   = "${local.name_prefix}-relayer-kms-signing"
  role   = local.managed_signer_task_role_names["relayer"]
  policy = data.aws_iam_policy_document.relayer_kms_signing[0].json
}

resource "aws_ecs_task_definition" "relayer" {
  family                   = "${local.name_prefix}-relayer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.relayer_execution.arn
  task_role_arn            = local.managed_signer_task_role_arns["relayer"]

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "relayer-tmp"
  }

  container_definitions = jsonencode([local.relayer_container])

  lifecycle {
    create_before_destroy = true
  }

  tags = { ReviewedConfigSha256 = local.relayer_reviewed_config_sha256 }
}

resource "aws_ecs_service" "relayer" {
  name                               = "${local.name_prefix}-relayer"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.relayer.arn
  desired_count                      = local.relayer_kms_enabled ? 1 : 0
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.internal_services.id, local.data_client_sg_id]
    subnets          = local.private_subnet_ids
  }

  service_registries {
    registry_arn = aws_service_discovery_service.runtime["relayer"].arn
  }

  depends_on = [aws_iam_role_policy.relayer_execution, aws_iam_role_policy.relayer_kms_signing]
}
