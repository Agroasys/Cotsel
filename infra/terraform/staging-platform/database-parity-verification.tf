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

  database_parity_verification_command = <<-COMMAND
    set -eu
    set -o pipefail

    : "$${AUTH_RUNTIME_USERNAME:?AUTH_RUNTIME_USERNAME is required}"
    : "$${AUTH_RUNTIME_PASSWORD:?AUTH_RUNTIME_PASSWORD is required}"
    : "$${GATEWAY_RUNTIME_USERNAME:?GATEWAY_RUNTIME_USERNAME is required}"
    : "$${GATEWAY_RUNTIME_PASSWORD:?GATEWAY_RUNTIME_PASSWORD is required}"
    : "$${INDEXER_RUNTIME_USERNAME:?INDEXER_RUNTIME_USERNAME is required}"
    : "$${INDEXER_RUNTIME_PASSWORD:?INDEXER_RUNTIME_PASSWORD is required}"
    : "$${ORACLE_RUNTIME_USERNAME:?ORACLE_RUNTIME_USERNAME is required}"
    : "$${ORACLE_RUNTIME_PASSWORD:?ORACLE_RUNTIME_PASSWORD is required}"
    : "$${RECONCILIATION_RUNTIME_USERNAME:?RECONCILIATION_RUNTIME_USERNAME is required}"
    : "$${RECONCILIATION_RUNTIME_PASSWORD:?RECONCILIATION_RUNTIME_PASSWORD is required}"
    : "$${RICARDIAN_RUNTIME_USERNAME:?RICARDIAN_RUNTIME_USERNAME is required}"
    : "$${RICARDIAN_RUNTIME_PASSWORD:?RICARDIAN_RUNTIME_PASSWORD is required}"
    : "$${TREASURY_RUNTIME_USERNAME:?TREASURY_RUNTIME_USERNAME is required}"
    : "$${TREASURY_RUNTIME_PASSWORD:?TREASURY_RUNTIME_PASSWORD is required}"

    export PGHOST='${local.postgres_host}'
    export PGPORT='5432'
    export PGSSLMODE='verify-full'
    export PGSSLROOTCERT='/tmp/aws-rds-global-bundle.pem'

    umask 077
    trap 'rm -f "$${PGSSLROOTCERT}"' EXIT HUP INT TERM
    wget --quiet -O "$${PGSSLROOTCERT}" 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
    printf '%s  %s\n' 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3' "$${PGSSLROOTCERT}" | sha256sum -c -s

    collect_database() {
      service_name="$${1}"
      database_name="$${2}"
      runtime_username="$${3}"
      runtime_password="$${4}"

      export PGUSER="$${runtime_username}"
      export PGPASSWORD="$${runtime_password}"

      read -r server_version public_tables estimated_rows public_indexes public_constraints extension_count <<EOF
    $(psql --dbname "$${database_name}" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator ' ' <<'SQL'
    SELECT current_setting('server_version_num'),
           (SELECT count(*)
            FROM information_schema.tables
            WHERE table_schema = 'public'),
           (SELECT coalesce(sum(n_live_tup), 0)
            FROM pg_stat_user_tables
            WHERE schemaname = 'public'),
           (SELECT count(*)
            FROM pg_indexes
            WHERE schemaname = 'public'),
           (SELECT count(*)
            FROM pg_constraint constraint_row
            JOIN pg_namespace namespace_row
              ON namespace_row.oid = constraint_row.connamespace
            WHERE namespace_row.nspname = 'public'),
           (SELECT count(*) FROM pg_extension);
    SQL
    )
    EOF

      schema_sha256="$(pg_dump \
        --dbname "$${database_name}" \
        --schema-only \
        --no-owner \
        --no-privileges \
        --no-comments \
        --restrict-key='cotselverify' \
        | sha256sum \
        | awk '{print $1}')"

      printf '%s\n' \
        "DATABASE_PARITY_METRIC service=$${service_name} database=$${database_name} server_version=$${server_version} public_tables=$${public_tables} estimated_rows=$${estimated_rows} public_indexes=$${public_indexes} public_constraints=$${public_constraints} extensions=$${extension_count} schema_sha256=$${schema_sha256}"
    }

    collect_database 'auth' 'cotsel_auth' "$${AUTH_RUNTIME_USERNAME}" "$${AUTH_RUNTIME_PASSWORD}"
    collect_database 'gateway' 'cotsel_gateway' "$${GATEWAY_RUNTIME_USERNAME}" "$${GATEWAY_RUNTIME_PASSWORD}"
    collect_database 'indexer' 'cotsel_indexer' "$${INDEXER_RUNTIME_USERNAME}" "$${INDEXER_RUNTIME_PASSWORD}"
    collect_database 'oracle' 'cotsel_oracle' "$${ORACLE_RUNTIME_USERNAME}" "$${ORACLE_RUNTIME_PASSWORD}"
    collect_database 'reconciliation' 'cotsel_reconciliation' "$${RECONCILIATION_RUNTIME_USERNAME}" "$${RECONCILIATION_RUNTIME_PASSWORD}"
    collect_database 'ricardian' 'cotsel_ricardian' "$${RICARDIAN_RUNTIME_USERNAME}" "$${RICARDIAN_RUNTIME_PASSWORD}"
    collect_database 'treasury' 'cotsel_treasury' "$${TREASURY_RUNTIME_USERNAME}" "$${TREASURY_RUNTIME_PASSWORD}"

    unset AUTH_RUNTIME_PASSWORD GATEWAY_RUNTIME_PASSWORD INDEXER_RUNTIME_PASSWORD ORACLE_RUNTIME_PASSWORD
    unset RECONCILIATION_RUNTIME_PASSWORD RICARDIAN_RUNTIME_PASSWORD TREASURY_RUNTIME_PASSWORD
    printf '%s\n' 'Cotsel AWS database parity metrics collection passed.'
  COMMAND
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

  container_definitions = jsonencode([
    {
      name      = "database-parity-verification"
      image     = "public.ecr.aws/docker/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
      essential = true
      command   = ["/bin/sh", "-ec", local.database_parity_verification_command]
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
