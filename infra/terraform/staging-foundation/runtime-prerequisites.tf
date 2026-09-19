locals {
  name_prefix = "cotsel-${var.environment}"

  runtime_prerequisite_secret_names = toset([
    "database/indexer/reader",
    "database/reconciliation/reader",
    "notifications-webhook",
  ])

  existing_runtime_secret_names = toset([
    "database/indexer/runtime",
    "database/oracle/runtime",
    "database/reconciliation/runtime",
    "gateway-managed-signer",
    "gateway-to-oracle-auth",
    "rpc-base-sepolia-fallback",
    "rpc-base-sepolia-primary",
  ])

  isolated_runtime_services = toset([
    "gateway",
    "indexer-graphql",
    "oracle",
    "reconciliation",
    "relayer",
  ])

  existing_service_log_names = toset([
    "indexer-graphql",
    "indexer-pipeline",
    "oracle",
    "reconciliation",
  ])

  runtime_secret_arns = merge(
    { for name, secret in data.aws_secretsmanager_secret.runtime_existing : name => secret.arn },
    { for name, secret in aws_secretsmanager_secret.runtime_prerequisite : name => secret.arn },
  )

  service_log_group_arns = merge(
    {
      for name in local.existing_service_log_names :
      name => "arn:${data.aws_partition.current.partition}:logs:${var.region}:${var.account_id}:log-group:/agroasys/cotsel/staging/${name}"
    },
    { relayer = aws_cloudwatch_log_group.relayer.arn },
  )
}

data "terraform_remote_state" "network" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "staging-network/terraform.tfstate"
    region = var.state_bucket_region
  }
}

data "aws_secretsmanager_secret" "runtime_existing" {
  for_each = local.existing_runtime_secret_names
  name     = "/agroasys/${var.environment}/cotsel/${each.key}"
}

data "aws_security_group" "gateway" {
  name   = "${local.name_prefix}-gateway"
  vpc_id = data.terraform_remote_state.network.outputs.vpc_id
}

data "aws_security_group" "internal_services" {
  name   = "${local.name_prefix}-internal-services"
  vpc_id = data.terraform_remote_state.network.outputs.vpc_id
}

data "aws_service_discovery_dns_namespace" "runtime" {
  name = "cotsel-staging.internal"
  type = "DNS_PRIVATE"
}

resource "aws_secretsmanager_secret" "runtime_prerequisite" {
  for_each = local.runtime_prerequisite_secret_names

  name                    = "/agroasys/${var.environment}/cotsel/${each.key}"
  description             = "Cotsel ${var.environment} ${replace(each.key, "-", " ")}"
  kms_key_id              = data.aws_kms_alias.platform.target_key_arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "relayer" {
  name              = "/agroasys/cotsel/staging/relayer"
  retention_in_days = var.log_retention_days
  kms_key_id        = data.aws_kms_alias.platform.target_key_arn

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "runtime_execution" {
  for_each = toset([
    "indexer",
    "oracle",
    "reconciliation",
    "relayer",
  ])

  name                 = "${local.name_prefix}-${each.key}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = each.key
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "runtime_task" {
  for_each = toset([
    "indexer",
    "reconciliation",
  ])

  name                 = "${local.name_prefix}-${each.key}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = each.key
  }

  lifecycle {
    prevent_destroy = true
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
      data.aws_ecr_repository.existing["indexer-graphql"].arn,
      data.aws_ecr_repository.existing["indexer-pipeline"].arn,
    ]
  }

  statement {
    sid     = "WriteIndexerLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${local.service_log_group_arns["indexer-graphql"]}:*",
      "${local.service_log_group_arns["indexer-pipeline"]}:*",
    ]
  }

  statement {
    sid     = "ReadIndexerStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.runtime_secret_arns["database/indexer/reader"],
      local.runtime_secret_arns["database/indexer/runtime"],
      local.runtime_secret_arns["notifications-webhook"],
      local.runtime_secret_arns["rpc-base-sepolia-fallback"],
      local.runtime_secret_arns["rpc-base-sepolia-primary"],
    ]
  }

  statement {
    sid       = "DecryptIndexerStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.platform.target_key_arn]
  }
}

data "aws_iam_policy_document" "oracle_execution" {
  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullOracleRuntimeImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.aws_ecr_repository.existing["oracle"].arn]
  }

  statement {
    sid       = "WriteOracleLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.service_log_group_arns["oracle"]}:*"]
  }

  statement {
    sid     = "ReadOracleStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.runtime_secret_arns["database/oracle/runtime"],
      local.runtime_secret_arns["database/reconciliation/reader"],
      local.runtime_secret_arns["gateway-to-oracle-auth"],
      local.runtime_secret_arns["rpc-base-sepolia-fallback"],
      local.runtime_secret_arns["rpc-base-sepolia-primary"],
    ]
  }

  statement {
    sid       = "DecryptOracleStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.platform.target_key_arn]
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
    resources = [data.aws_ecr_repository.existing["reconciliation"].arn]
  }

  statement {
    sid       = "WriteReconciliationLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.service_log_group_arns["reconciliation"]}:*"]
  }

  statement {
    sid     = "ReadReconciliationStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.runtime_secret_arns["database/reconciliation/runtime"],
      local.runtime_secret_arns["rpc-base-sepolia-fallback"],
      local.runtime_secret_arns["rpc-base-sepolia-primary"],
    ]
  }

  statement {
    sid       = "DecryptReconciliationStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.platform.target_key_arn]
  }
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
    resources = [aws_ecr_repository.foundation["relayer"].arn]
  }

  statement {
    sid       = "WriteRelayerLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.relayer.arn}:*"]
  }

  statement {
    sid       = "ReadRelayerStartupSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.runtime_secret_arns["gateway-managed-signer"]]
  }

  statement {
    sid       = "DecryptRelayerStartupSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.platform.target_key_arn]
  }
}

resource "aws_iam_role_policy" "runtime_execution" {
  for_each = {
    indexer        = data.aws_iam_policy_document.indexer_execution.json
    oracle         = data.aws_iam_policy_document.oracle_execution.json
    reconciliation = data.aws_iam_policy_document.reconciliation_execution.json
    relayer        = data.aws_iam_policy_document.relayer_execution.json
  }

  name   = "${local.name_prefix}-${each.key}-execution"
  role   = aws_iam_role.runtime_execution[each.key].id
  policy = each.value
}

resource "aws_service_discovery_service" "runtime_prerequisite" {
  for_each = local.isolated_runtime_services

  name = each.value

  dns_config {
    namespace_id = data.aws_service_discovery_dns_namespace.runtime.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_vpc_security_group_ingress_rule" "indexer_from_gateway" {
  security_group_id            = data.aws_security_group.internal_services.id
  description                  = "Read-only indexer GraphQL access from the gateway."
  referenced_security_group_id = data.aws_security_group.gateway.id
  from_port                    = 4350
  to_port                      = 4350
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "indexer_from_services" {
  security_group_id            = data.aws_security_group.internal_services.id
  description                  = "Read-only indexer GraphQL access from private Cotsel services."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 4350
  to_port                      = 4350
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "reconciliation_from_gateway" {
  security_group_id            = data.aws_security_group.internal_services.id
  description                  = "Reconciliation status access from the gateway."
  referenced_security_group_id = data.aws_security_group.gateway.id
  from_port                    = 9090
  to_port                      = 9090
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_indexer" {
  security_group_id            = data.aws_security_group.gateway.id
  description                  = "Read-only GraphQL calls from the gateway to the isolated indexer."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 4350
  to_port                      = 4350
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "services_to_indexer" {
  security_group_id            = data.aws_security_group.internal_services.id
  description                  = "Read-only GraphQL calls between private services and the isolated indexer."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 4350
  to_port                      = 4350
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_reconciliation" {
  security_group_id            = data.aws_security_group.gateway.id
  description                  = "Reconciliation status calls from the gateway."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 9090
  to_port                      = 9090
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_oracle" {
  security_group_id            = data.aws_security_group.gateway.id
  description                  = "Authenticated private HTTP calls from the gateway to Oracle."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_relayer" {
  security_group_id            = data.aws_security_group.gateway.id
  description                  = "Authenticated intent-bound signing requests to the gasless relayer."
  referenced_security_group_id = data.aws_security_group.internal_services.id
  from_port                    = 3300
  to_port                      = 3300
  ip_protocol                  = "tcp"
}
