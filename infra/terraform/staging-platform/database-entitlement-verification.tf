locals {
  database_entitlement_verification_command = <<-COMMAND
    set -eu

    : "$${RICARDIAN_MIGRATION_USERNAME:?RICARDIAN_MIGRATION_USERNAME is required}"
    : "$${RICARDIAN_MIGRATION_PASSWORD:?RICARDIAN_MIGRATION_PASSWORD is required}"
    : "$${RICARDIAN_RUNTIME_USERNAME:?RICARDIAN_RUNTIME_USERNAME is required}"
    : "$${RICARDIAN_RUNTIME_PASSWORD:?RICARDIAN_RUNTIME_PASSWORD is required}"
    : "$${TREASURY_MIGRATION_USERNAME:?TREASURY_MIGRATION_USERNAME is required}"
    : "$${TREASURY_MIGRATION_PASSWORD:?TREASURY_MIGRATION_PASSWORD is required}"
    : "$${TREASURY_RUNTIME_USERNAME:?TREASURY_RUNTIME_USERNAME is required}"
    : "$${TREASURY_RUNTIME_PASSWORD:?TREASURY_RUNTIME_PASSWORD is required}"

    [ "$${RICARDIAN_MIGRATION_USERNAME}" = 'cotsel_ricardian_migrator' ]
    [ "$${RICARDIAN_RUNTIME_USERNAME}" = 'cotsel_ricardian_runtime' ]
    [ "$${TREASURY_MIGRATION_USERNAME}" = 'cotsel_treasury_migrator' ]
    [ "$${TREASURY_RUNTIME_USERNAME}" = 'cotsel_treasury_runtime' ]

    export PGHOST='${local.postgres_host}'
    export PGPORT='5432'
    export PGSSLMODE='verify-full'
    export PGSSLROOTCERT='/tmp/aws-rds-global-bundle.pem'

    umask 077
    trap 'rm -f "$${PGSSLROOTCERT}"' EXIT HUP INT TERM
    wget --quiet -O "$${PGSSLROOTCERT}" 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
    printf '%s  %s\n' 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3' "$${PGSSLROOTCERT}" | sha256sum -c -s

    verify_service() {
      database_name="$${1}"
      other_database_name="$${2}"
      migration_username="$${3}"
      migration_password="$${4}"
      runtime_username="$${5}"
      runtime_password="$${6}"
      probe_schema="cotsel_entitlement_probe_$${database_name}_$$"

      export PGUSER="$${migration_username}"
      export PGPASSWORD="$${migration_password}"
      psql --dbname "$${database_name}" --set ON_ERROR_STOP=1 --quiet >/dev/null <<SQL
    BEGIN;
    CREATE SCHEMA $${probe_schema};
    ROLLBACK;
    SQL

      export PGUSER="$${runtime_username}"
      export PGPASSWORD="$${runtime_password}"
      psql --dbname "$${database_name}" --set ON_ERROR_STOP=1 --quiet -c 'SELECT 1' >/dev/null

      if psql --dbname "$${database_name}" --set ON_ERROR_STOP=1 --quiet >/dev/null 2>&1 <<SQL
    BEGIN;
    CREATE SCHEMA $${probe_schema};
    ROLLBACK;
    SQL
      then
        printf '%s\n' "Runtime role unexpectedly created schema in $${database_name}." >&2
        exit 1
      fi

      if psql --dbname "$${other_database_name}" --set ON_ERROR_STOP=1 --quiet -c 'SELECT 1' >/dev/null 2>&1; then
        printf '%s\n' "Runtime role unexpectedly connected to $${other_database_name}." >&2
        exit 1
      fi
    }

    verify_service \
      'cotsel_ricardian' \
      'cotsel_treasury' \
      "$${RICARDIAN_MIGRATION_USERNAME}" \
      "$${RICARDIAN_MIGRATION_PASSWORD}" \
      "$${RICARDIAN_RUNTIME_USERNAME}" \
      "$${RICARDIAN_RUNTIME_PASSWORD}"
    verify_service \
      'cotsel_treasury' \
      'cotsel_ricardian' \
      "$${TREASURY_MIGRATION_USERNAME}" \
      "$${TREASURY_MIGRATION_PASSWORD}" \
      "$${TREASURY_RUNTIME_USERNAME}" \
      "$${TREASURY_RUNTIME_PASSWORD}"

    unset RICARDIAN_MIGRATION_PASSWORD RICARDIAN_RUNTIME_PASSWORD TREASURY_MIGRATION_PASSWORD TREASURY_RUNTIME_PASSWORD
    printf '%s\n' 'Cotsel Treasury and Ricardian database entitlement verification passed.'
  COMMAND
}

resource "aws_cloudwatch_log_group" "database_entitlement_verification" {
  name              = "/agroasys/cotsel/${var.environment}/database-entitlement-verification"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn

  tags = {
    Environment = var.environment
    Service     = "database-entitlement-verification"
  }
}

resource "aws_iam_role" "database_entitlement_verification_execution" {
  name                 = "${local.name_prefix}-database-entitlement-verification-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.database_bootstrap_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "database-entitlement-verification"
  }
}

data "aws_iam_policy_document" "database_entitlement_verification_execution" {
  statement {
    sid       = "GetPublicPostgresImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteEntitlementVerificationLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.database_entitlement_verification.arn}:*"]
  }

  statement {
    sid     = "ReadOnlyEntitlementVerificationSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = flatten([
      for service in values(local.database_bootstrap_services) : [
        service.migration_secret,
        service.runtime_secret,
      ]
    ])
  }

  statement {
    sid       = "DecryptOnlyEntitlementVerificationSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "database_entitlement_verification_execution" {
  name   = "${local.name_prefix}-database-entitlement-verification-execution"
  role   = aws_iam_role.database_entitlement_verification_execution.id
  policy = data.aws_iam_policy_document.database_entitlement_verification_execution.json
}

resource "aws_ecs_task_definition" "database_entitlement_verification" {
  family                   = "${local.name_prefix}-database-entitlement-verification"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.database_entitlement_verification_execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "database-entitlement-verification"
      image     = "public.ecr.aws/docker/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
      essential = true
      command   = ["/bin/sh", "-ec", local.database_entitlement_verification_command]
      secrets = [
        { name = "RICARDIAN_MIGRATION_PASSWORD", valueFrom = "${local.database_bootstrap_services.ricardian.migration_secret}:password::" },
        { name = "RICARDIAN_MIGRATION_USERNAME", valueFrom = "${local.database_bootstrap_services.ricardian.migration_secret}:username::" },
        { name = "RICARDIAN_RUNTIME_PASSWORD", valueFrom = "${local.database_bootstrap_services.ricardian.runtime_secret}:password::" },
        { name = "RICARDIAN_RUNTIME_USERNAME", valueFrom = "${local.database_bootstrap_services.ricardian.runtime_secret}:username::" },
        { name = "TREASURY_MIGRATION_PASSWORD", valueFrom = "${local.database_bootstrap_services.treasury.migration_secret}:password::" },
        { name = "TREASURY_MIGRATION_USERNAME", valueFrom = "${local.database_bootstrap_services.treasury.migration_secret}:username::" },
        { name = "TREASURY_RUNTIME_PASSWORD", valueFrom = "${local.database_bootstrap_services.treasury.runtime_secret}:password::" },
        { name = "TREASURY_RUNTIME_USERNAME", valueFrom = "${local.database_bootstrap_services.treasury.runtime_secret}:username::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.database_entitlement_verification.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "verify"
        }
      }
    },
  ])

  depends_on = [aws_iam_role_policy.database_entitlement_verification_execution]
}
