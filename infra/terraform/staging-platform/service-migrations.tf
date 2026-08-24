locals {
  service_migrations = {
    auth = {
      database     = "cotsel_auth"
      runtime_user = "cotsel_auth_app"
      schema_path  = "/app/auth/dist/database/schema.sql"
    }
    gateway = {
      database     = "cotsel_gateway"
      runtime_user = "cotsel_gateway_runtime"
      schema_path  = "/app/gateway/dist/database/schema.sql"
    }
    oracle = {
      database     = "cotsel_oracle"
      runtime_user = "cotsel_oracle_app"
      schema_path  = "/app/oracle/dist/database/schema.sql"
    }
    reconciliation = {
      database     = "cotsel_reconciliation"
      runtime_user = "cotsel_reconciliation_app"
      schema_path  = "/app/reconciliation/src/database/schema.sql"
    }
    ricardian = {
      database     = "cotsel_ricardian"
      runtime_user = "cotsel_ricardian_runtime"
      schema_path  = "/app/ricardian/src/database/schema.sql"
    }
    treasury = {
      database     = "cotsel_treasury"
      runtime_user = "cotsel_treasury_runtime"
      schema_path  = "/app/treasury/src/database/schema.sql"
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

  container_definitions = jsonencode([
    {
      name      = "${each.key}-migrate"
      image     = local.runtime_images[each.key]
      essential = true
      command   = ["node", "shared-db/migrate.js"]
      environment = [
        { name = "DB_HOST", value = local.postgres_host },
        { name = "DB_NAME", value = each.value.database },
        { name = "DB_PORT", value = "5432" },
        { name = "DB_RUNTIME_USER", value = each.value.runtime_user },
        { name = "DB_SSL_MODE", value = "verify-full" },
        { name = "MIGRATION_SCHEMA_PATH", value = each.value.schema_path },
        { name = "MIGRATION_SERVICE_NAME", value = each.key },
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
