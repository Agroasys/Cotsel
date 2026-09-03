locals {
  service_migrations = {
    auth = {
      database      = "cotsel_auth"
      runtime_user  = "cotsel_auth_app"
      manifest_path = "/app/auth/dist/database/migrations.json"
    }
    gateway = {
      database      = "cotsel_gateway"
      runtime_user  = "cotsel_gateway_runtime"
      manifest_path = "/app/gateway/dist/database/migrations.json"
    }
    oracle = {
      database      = "cotsel_oracle"
      runtime_user  = "cotsel_oracle_app"
      manifest_path = "/app/oracle/dist/database/migrations.json"
    }
    reconciliation = {
      database      = "cotsel_reconciliation"
      runtime_user  = "cotsel_reconciliation_app"
      manifest_path = "/app/reconciliation/dist/database/migrations.json"
    }
    ricardian = {
      database      = "cotsel_ricardian"
      runtime_user  = "cotsel_ricardian_runtime"
      manifest_path = "/app/ricardian/dist/database/migrations.json"
    }
    treasury = {
      database      = "cotsel_treasury"
      runtime_user  = "cotsel_treasury_runtime"
      manifest_path = "/app/treasury/dist/database/migrations.json"
    }
  }
}

resource "aws_iam_role" "service_migration_execution" {
  for_each = local.service_migrations

  name                 = "${local.name_prefix}-${each.key}-migration-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "${each.key}-migration"
  }
}

data "aws_iam_policy_document" "service_migration_execution" {
  for_each = local.service_migrations

  statement {
    sid       = "GetMigrationImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullMigrationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.service[each.key].arn]
  }

  statement {
    sid    = "WriteMigrationLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service[each.key].arn}:*"]
  }

  statement {
    sid       = "ReadMigrationSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.platform["database/${each.key}/migration"].arn]
  }

  statement {
    sid       = "DecryptMigrationSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "service_migration_execution" {
  for_each = local.service_migrations

  name   = "${local.name_prefix}-${each.key}-migration-execution"
  role   = aws_iam_role.service_migration_execution[each.key].id
  policy = data.aws_iam_policy_document.service_migration_execution[each.key].json
}

resource "aws_ecs_task_definition" "service_migration" {
  for_each = local.service_migrations

  family                   = "${local.name_prefix}-${each.key}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.service_migration_execution[each.key].arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "${each.key}-migrate"
      image                  = local.runtime_images[each.key]
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      command                = ["node", "shared-db/migrate.js"]
      environment = [
        { name = "DB_HOST", value = local.postgres_host },
        { name = "DB_NAME", value = each.value.database },
        { name = "DB_PORT", value = "5432" },
        { name = "DB_RUNTIME_USER", value = each.value.runtime_user },
        { name = "DB_SSL_MODE", value = "verify-full" },
        { name = "MIGRATION_LOCK_TIMEOUT_MS", value = "30000" },
        { name = "MIGRATION_MANIFEST_PATH", value = each.value.manifest_path },
        { name = "MIGRATION_SERVICE_NAME", value = each.key },
        { name = "MIGRATION_STATEMENT_TIMEOUT_MS", value = "300000" },
        { name = "NODE_ENV", value = "production" },
        { name = "PGSSLMODE", value = "verify-full" },
      ]
      secrets = [
        { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/${each.key}/migration"].arn}:password::" },
        { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/${each.key}/migration"].arn}:username::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrate"
        }
      }
    },
  ])

  depends_on = [aws_iam_role_policy.service_migration_execution]
}
