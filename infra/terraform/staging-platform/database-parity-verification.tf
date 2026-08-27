locals {
  # This task reports aggregate-only facts from every AWS Cotsel service
  # database before an import. It is deliberately not an importer: source
  # state remains authoritative until a separately governed cutover accepts
  # matching source and target evidence.
  database_parity_verification_services = {
    auth = {
      database_name  = "cotsel_auth"
      runtime_secret = aws_secretsmanager_secret.platform["database/auth/runtime"].arn
    }
    gateway = {
      database_name  = "cotsel_gateway"
      runtime_secret = aws_secretsmanager_secret.platform["database/gateway/runtime"].arn
    }
    indexer = {
      database_name  = "cotsel_indexer"
      runtime_secret = aws_secretsmanager_secret.platform["database/indexer/runtime"].arn
    }
    oracle = {
      database_name  = "cotsel_oracle"
      runtime_secret = aws_secretsmanager_secret.platform["database/oracle/runtime"].arn
    }
    reconciliation = {
      database_name  = "cotsel_reconciliation"
      runtime_secret = aws_secretsmanager_secret.platform["database/reconciliation/runtime"].arn
    }
    ricardian = {
      database_name  = "cotsel_ricardian"
      runtime_secret = aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn
    }
    treasury = {
      database_name  = "cotsel_treasury"
      runtime_secret = aws_secretsmanager_secret.platform["database/treasury/runtime"].arn
    }
  }

  database_parity_verification_command = file("${path.module}/../../../scripts/postgres-recovery-manifest.sh")
}

resource "aws_cloudwatch_log_group" "database_parity_verification" {
  name              = "/agroasys/cotsel/${var.environment}/database-parity-verification"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn

  tags = {
    Environment = var.environment
    Service     = "database-parity-verification"
  }
}

resource "aws_iam_role" "database_parity_verification_execution" {
  name                 = "${local.name_prefix}-db-parity-verifier"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.database_parity_verification_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "database-parity-verification"
  }
}

data "aws_iam_policy_document" "database_parity_verification_execution" {
  statement {
    sid       = "GetPublicPostgresImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteDatabaseParityVerificationLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.database_parity_verification.arn}:*"]
  }

  statement {
    sid       = "ReadOnlyDatabaseParityRuntimeCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for service in values(local.database_parity_verification_services) : service.runtime_secret]
  }

  statement {
    sid       = "DecryptOnlyDatabaseParityRuntimeCredentials"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "database_parity_verification_execution" {
  name   = "${local.name_prefix}-db-parity-verifier"
  role   = aws_iam_role.database_parity_verification_execution.id
  policy = data.aws_iam_policy_document.database_parity_verification_execution.json
}

resource "aws_ecs_task_definition" "database_parity_verification" {
  family                   = "${local.name_prefix}-database-parity-verification"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.database_parity_verification_execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "database-parity-verification"
      image                  = "public.ecr.aws/docker/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      command                = ["/bin/sh", "-ec", local.database_parity_verification_command]
      environment = [
        { name = "COTSEL_POSTGRES_HOST", value = local.postgres_host },
      ]
      secrets = flatten([
        for service_name, service in local.database_parity_verification_services : [
          {
            name      = "${upper(service_name)}_RUNTIME_PASSWORD"
            valueFrom = "${service.runtime_secret}:password::"
          },
          {
            name      = "${upper(service_name)}_RUNTIME_USERNAME"
            valueFrom = "${service.runtime_secret}:username::"
          },
        ]
      ])
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.database_parity_verification.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "verify"
        }
      }
    },
  ])

  depends_on = [aws_iam_role_policy.database_parity_verification_execution]
}
