data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    sid     = "AllowEcsTasksAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "gateway_execution" {
  name                 = "${local.name_prefix}-gateway-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "gateway"
  }
}

resource "aws_iam_role" "gateway_task" {
  name                 = "${local.name_prefix}-gateway-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "gateway"
  }
}

data "aws_iam_policy_document" "gateway_execution" {
  statement {
    sid       = "GetRuntimeImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullRuntimeImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for service in local.runtime_services : aws_ecr_repository.service[service].arn]
  }

  statement {
    sid    = "WriteRuntimeLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      for service in local.runtime_services : "${aws_cloudwatch_log_group.service[service].arn}:*"
    ]
  }

  statement {
    sid     = "ReadRuntimeStartupSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.platform["database/gateway/runtime"].arn,
      aws_secretsmanager_secret.platform["database/indexer/reader"].arn,
      aws_secretsmanager_secret.platform["database/indexer/runtime"].arn,
      aws_secretsmanager_secret.platform["database/oracle/runtime"].arn,
      aws_secretsmanager_secret.platform["database/reconciliation/runtime"].arn,
      aws_secretsmanager_secret.platform["database/auth/runtime"].arn,
      aws_secretsmanager_secret.platform["gateway-settlement-callback"].arn,
      aws_secretsmanager_secret.platform["gateway-settlement-ingress"].arn,
      aws_secretsmanager_secret.platform["gateway-to-oracle-auth"].arn,
      aws_secretsmanager_secret.platform["gateway-to-ricardian-auth"].arn,
      aws_secretsmanager_secret.platform["gateway-to-treasury-auth"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-fallback"].arn,
      aws_secretsmanager_secret.platform["rpc-base-sepolia-primary"].arn,
      data.aws_secretsmanager_secret.oracle_wallet.arn,
    ]
  }

  statement {
    sid       = "DecryptGatewayStartupSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "gateway_execution" {
  name   = "${local.name_prefix}-gateway-execution"
  role   = aws_iam_role.gateway_execution.id
  policy = data.aws_iam_policy_document.gateway_execution.json
}
