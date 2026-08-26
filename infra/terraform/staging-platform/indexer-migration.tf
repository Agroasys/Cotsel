resource "aws_iam_role" "indexer_migration_execution" {
  name                 = "${local.name_prefix}-indexer-migration-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "indexer-migration"
  }
}

data "aws_iam_policy_document" "indexer_migration_execution" {
  statement {
    sid       = "GetMigrationImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullIndexerMigrationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.service["indexer-pipeline"].arn]
  }

  statement {
    sid    = "WriteIndexerMigrationLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service["indexer-pipeline"].arn}:*"]
  }

  statement {
    sid       = "ReadIndexerMigrationSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.platform["database/indexer/migration"].arn]
  }

  statement {
    sid       = "DecryptIndexerMigrationSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "indexer_migration_execution" {
  name   = "${local.name_prefix}-indexer-migration-execution"
  role   = aws_iam_role.indexer_migration_execution.id
  policy = data.aws_iam_policy_document.indexer_migration_execution.json
}

resource "aws_ecs_task_definition" "indexer_migration" {
  family                   = "${local.name_prefix}-indexer-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.indexer_migration_execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "indexer-migrate"
      image                  = local.runtime_images["indexer-pipeline"]
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      workingDirectory       = "/app/indexer"
      command                = ["./node_modules/.bin/squid-typeorm-migration", "apply"]
      environment = [
        { name = "DB_HOST", value = local.postgres_host },
        { name = "DB_NAME", value = "cotsel_indexer" },
        { name = "DB_PORT", value = "5432" },
        { name = "DB_SSL_MODE", value = "verify-full" },
        { name = "PGSSLMODE", value = "verify-full" },
      ]
      secrets = [
        { name = "DB_PASS", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/migration"].arn}:password::" },
        { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/migration"].arn}:password::" },
        { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.platform["database/indexer/migration"].arn}:username::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["indexer-pipeline"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrate"
        }
      }
    },
  ])

  depends_on = [aws_iam_role_policy.indexer_migration_execution]
}
