locals {
  database_bootstrap_services = {
    indexer = {
      database_name    = "cotsel_indexer"
      migration_role   = "cotsel_indexer_migrator"
      migration_secret = aws_secretsmanager_secret.platform["database/indexer/migration"].arn
      reader_role      = "cotsel_indexer_reader"
      reader_secret    = aws_secretsmanager_secret.platform["database/indexer/reader"].arn
      runtime_role     = "cotsel_indexer_app"
      runtime_secret   = aws_secretsmanager_secret.platform["database/indexer/runtime"].arn
    }
    ricardian = {
      database_name    = "cotsel_ricardian"
      migration_role   = "cotsel_ricardian_migrator"
      migration_secret = aws_secretsmanager_secret.platform["database/ricardian/migration"].arn
      runtime_role     = "cotsel_ricardian_runtime"
      runtime_secret   = aws_secretsmanager_secret.platform["database/ricardian/runtime"].arn
    }
    treasury = {
      database_name    = "cotsel_treasury"
      migration_role   = "cotsel_treasury_migrator"
      migration_secret = aws_secretsmanager_secret.platform["database/treasury/migration"].arn
      runtime_role     = "cotsel_treasury_runtime"
      runtime_secret   = aws_secretsmanager_secret.platform["database/treasury/runtime"].arn
    }
  }

  database_bootstrap_command = <<-COMMAND
    set -eu

    : "$${MASTER_USERNAME:?MASTER_USERNAME is required}"
    : "$${MASTER_PASSWORD:?MASTER_PASSWORD is required}"
    : "$${INDEXER_MIGRATION_USERNAME:?INDEXER_MIGRATION_USERNAME is required}"
    : "$${INDEXER_MIGRATION_PASSWORD:?INDEXER_MIGRATION_PASSWORD is required}"
    : "$${INDEXER_RUNTIME_USERNAME:?INDEXER_RUNTIME_USERNAME is required}"
    : "$${INDEXER_RUNTIME_PASSWORD:?INDEXER_RUNTIME_PASSWORD is required}"
    : "$${INDEXER_READER_USERNAME:?INDEXER_READER_USERNAME is required}"
    : "$${INDEXER_READER_PASSWORD:?INDEXER_READER_PASSWORD is required}"
    : "$${RICARDIAN_MIGRATION_USERNAME:?RICARDIAN_MIGRATION_USERNAME is required}"
    : "$${RICARDIAN_MIGRATION_PASSWORD:?RICARDIAN_MIGRATION_PASSWORD is required}"
    : "$${RICARDIAN_RUNTIME_USERNAME:?RICARDIAN_RUNTIME_USERNAME is required}"
    : "$${RICARDIAN_RUNTIME_PASSWORD:?RICARDIAN_RUNTIME_PASSWORD is required}"
    : "$${TREASURY_MIGRATION_USERNAME:?TREASURY_MIGRATION_USERNAME is required}"
    : "$${TREASURY_MIGRATION_PASSWORD:?TREASURY_MIGRATION_PASSWORD is required}"
    : "$${TREASURY_RUNTIME_USERNAME:?TREASURY_RUNTIME_USERNAME is required}"
    : "$${TREASURY_RUNTIME_PASSWORD:?TREASURY_RUNTIME_PASSWORD is required}"

    [ "$${INDEXER_MIGRATION_USERNAME}" = 'cotsel_indexer_migrator' ]
    [ "$${INDEXER_RUNTIME_USERNAME}" = 'cotsel_indexer_app' ]
    [ "$${INDEXER_READER_USERNAME}" = 'cotsel_indexer_reader' ]
    [ "$${RICARDIAN_MIGRATION_USERNAME}" = 'cotsel_ricardian_migrator' ]
    [ "$${RICARDIAN_RUNTIME_USERNAME}" = 'cotsel_ricardian_runtime' ]
    [ "$${TREASURY_MIGRATION_USERNAME}" = 'cotsel_treasury_migrator' ]
    [ "$${TREASURY_RUNTIME_USERNAME}" = 'cotsel_treasury_runtime' ]

    export PGHOST='${local.postgres_host}'
    export PGPORT='5432'
    export PGSSLMODE='verify-full'
    export PGSSLROOTCERT='/tmp/aws-rds-global-bundle.pem'
    export PGUSER="$${MASTER_USERNAME}"
    export PGPASSWORD="$${MASTER_PASSWORD}"

    # The bootstrap image is the upstream PostgreSQL image, so it does not
    # contain AWS RDS roots. Fetch the same pinned public bundle used by the
    # Cotsel runtime images before any database connection is attempted.
    umask 077
    trap 'rm -f "$${PGSSLROOTCERT}"' EXIT HUP INT TERM
    wget --quiet -O "$${PGSSLROOTCERT}" 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
    printf '%s  %s\n' 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3' "$${PGSSLROOTCERT}" | sha256sum -c -s

    psql --dbname postgres --set ON_ERROR_STOP=1 <<SQL
    \getenv indexer_migration_password INDEXER_MIGRATION_PASSWORD
    \getenv indexer_runtime_password INDEXER_RUNTIME_PASSWORD
    \getenv indexer_reader_password INDEXER_READER_PASSWORD
    \getenv ricardian_migration_password RICARDIAN_MIGRATION_PASSWORD
    \getenv ricardian_runtime_password RICARDIAN_RUNTIME_PASSWORD
    \getenv treasury_migration_password TREASURY_MIGRATION_PASSWORD
    \getenv treasury_runtime_password TREASURY_RUNTIME_PASSWORD
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_indexer_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_indexer_migrator')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_indexer_app')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_indexer_app')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_indexer_reader')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_indexer_reader')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_ricardian_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_ricardian_migrator')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_ricardian_runtime')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_ricardian_runtime')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_treasury_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_treasury_migrator')
    \gexec
    SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'cotsel_treasury_runtime')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cotsel_treasury_runtime')
    \gexec
    ALTER ROLE cotsel_indexer_migrator LOGIN PASSWORD :'indexer_migration_password';
    ALTER ROLE cotsel_indexer_app LOGIN PASSWORD :'indexer_runtime_password';
    ALTER ROLE cotsel_indexer_reader LOGIN PASSWORD :'indexer_reader_password';
    ALTER ROLE cotsel_ricardian_migrator LOGIN PASSWORD :'ricardian_migration_password';
    ALTER ROLE cotsel_ricardian_runtime LOGIN PASSWORD :'ricardian_runtime_password';
    ALTER ROLE cotsel_treasury_migrator LOGIN PASSWORD :'treasury_migration_password';
    ALTER ROLE cotsel_treasury_runtime LOGIN PASSWORD :'treasury_runtime_password';
    SELECT format('CREATE DATABASE %I OWNER %I', 'cotsel_indexer', 'cotsel_indexer_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cotsel_indexer')
    \gexec
    SELECT format('CREATE DATABASE %I OWNER %I', 'cotsel_ricardian', 'cotsel_ricardian_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cotsel_ricardian')
    \gexec
    SELECT format('CREATE DATABASE %I OWNER %I', 'cotsel_treasury', 'cotsel_treasury_migrator')
    WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cotsel_treasury')
    \gexec
    SQL

    psql --dbname cotsel_indexer --set ON_ERROR_STOP=1 <<SQL
    BEGIN;
    GRANT cotsel_indexer_app, cotsel_indexer_migrator TO CURRENT_USER;
    REVOKE ALL ON DATABASE cotsel_indexer FROM PUBLIC;
    REVOKE ALL ON DATABASE cotsel_indexer FROM cotsel_indexer_app, cotsel_indexer_reader;
    GRANT CONNECT ON DATABASE cotsel_indexer TO cotsel_indexer_migrator, cotsel_indexer_app, cotsel_indexer_reader;
    REASSIGN OWNED BY cotsel_indexer_app TO cotsel_indexer_migrator;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ALTER SCHEMA public OWNER TO cotsel_indexer_migrator;
    REVOKE ALL ON SCHEMA public FROM cotsel_indexer_app, cotsel_indexer_reader;
    GRANT USAGE, CREATE ON SCHEMA public TO cotsel_indexer_migrator;
    GRANT USAGE ON SCHEMA public TO cotsel_indexer_app, cotsel_indexer_reader;
    CREATE SCHEMA IF NOT EXISTS squid_processor AUTHORIZATION cotsel_indexer_migrator;
    ALTER SCHEMA squid_processor OWNER TO cotsel_indexer_migrator;
    ALTER DATABASE cotsel_indexer OWNER TO cotsel_indexer_migrator;
    REVOKE ALL ON SCHEMA squid_processor FROM PUBLIC;
    REVOKE ALL ON SCHEMA squid_processor FROM cotsel_indexer_app, cotsel_indexer_reader;
    GRANT USAGE, CREATE ON SCHEMA squid_processor TO cotsel_indexer_migrator;
    GRANT USAGE ON SCHEMA squid_processor TO cotsel_indexer_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cotsel_indexer_app, cotsel_indexer_reader;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM cotsel_indexer_app, cotsel_indexer_reader;
    REVOKE ALL ON ALL TABLES IN SCHEMA squid_processor FROM cotsel_indexer_app, cotsel_indexer_reader;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA squid_processor FROM cotsel_indexer_app, cotsel_indexer_reader;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cotsel_indexer_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO cotsel_indexer_reader;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO cotsel_indexer_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA squid_processor TO cotsel_indexer_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA squid_processor TO cotsel_indexer_app;
    REVOKE cotsel_indexer_app, cotsel_indexer_migrator FROM CURRENT_USER;
    COMMIT;
    SQL

    export PGUSER="$${INDEXER_MIGRATION_USERNAME}"
    export PGPASSWORD="$${INDEXER_MIGRATION_PASSWORD}"
    psql --dbname cotsel_indexer --set ON_ERROR_STOP=1 <<SQL
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM cotsel_indexer_app, cotsel_indexer_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM cotsel_indexer_app, cotsel_indexer_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA squid_processor REVOKE ALL ON TABLES FROM cotsel_indexer_app, cotsel_indexer_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA squid_processor REVOKE ALL ON SEQUENCES FROM cotsel_indexer_app, cotsel_indexer_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_indexer_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cotsel_indexer_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cotsel_indexer_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA squid_processor GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_indexer_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA squid_processor GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cotsel_indexer_app;
    SQL

    export PGUSER="$${MASTER_USERNAME}"
    export PGPASSWORD="$${MASTER_PASSWORD}"
    psql --dbname cotsel_ricardian --set ON_ERROR_STOP=1 <<SQL
    REVOKE ALL ON DATABASE cotsel_ricardian FROM PUBLIC;
    GRANT CONNECT ON DATABASE cotsel_ricardian TO cotsel_ricardian_migrator, cotsel_ricardian_runtime;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE, CREATE ON SCHEMA public TO cotsel_ricardian_migrator;
    GRANT USAGE ON SCHEMA public TO cotsel_ricardian_runtime;
    SQL

    # PostgreSQL only lets the object-creating role set its default privileges.
    # Connect as each migrator so future migrations grant the runtime role access.
    export PGUSER="$${RICARDIAN_MIGRATION_USERNAME}"
    export PGPASSWORD="$${RICARDIAN_MIGRATION_PASSWORD}"
    psql --dbname cotsel_ricardian --set ON_ERROR_STOP=1 <<SQL
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_ricardian_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cotsel_ricardian_runtime;
    SQL

    export PGUSER="$${MASTER_USERNAME}"
    export PGPASSWORD="$${MASTER_PASSWORD}"
    psql --dbname cotsel_treasury --set ON_ERROR_STOP=1 <<SQL
    REVOKE ALL ON DATABASE cotsel_treasury FROM PUBLIC;
    GRANT CONNECT ON DATABASE cotsel_treasury TO cotsel_treasury_migrator, cotsel_treasury_runtime;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE, CREATE ON SCHEMA public TO cotsel_treasury_migrator;
    GRANT USAGE ON SCHEMA public TO cotsel_treasury_runtime;
    SQL

    export PGUSER="$${TREASURY_MIGRATION_USERNAME}"
    export PGPASSWORD="$${TREASURY_MIGRATION_PASSWORD}"
    psql --dbname cotsel_treasury --set ON_ERROR_STOP=1 <<SQL
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_treasury_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cotsel_treasury_runtime;
    SQL

    unset MASTER_PASSWORD INDEXER_MIGRATION_PASSWORD INDEXER_RUNTIME_PASSWORD INDEXER_READER_PASSWORD
    unset RICARDIAN_MIGRATION_PASSWORD RICARDIAN_RUNTIME_PASSWORD TREASURY_MIGRATION_PASSWORD TREASURY_RUNTIME_PASSWORD
    printf '%s\n' 'Cotsel Indexer, Treasury, and Ricardian database roles and grants are configured.'
  COMMAND
}

resource "aws_cloudwatch_log_group" "database_bootstrap" {
  name              = "/agroasys/cotsel/${var.environment}/database-bootstrap"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn

  tags = {
    Environment = var.environment
    Service     = "database-bootstrap"
  }
}

resource "aws_iam_role" "database_bootstrap_execution" {
  name                 = "agroasys-cotsel-staging-db-bootstrap-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.database_bootstrap_permissions_boundary_arn

  tags = {
    Environment = var.environment
    Service     = "database-bootstrap"
  }
}

data "aws_iam_policy_document" "database_bootstrap_execution" {
  statement {
    sid       = "GetPublicPostgresImageAuthorization"
    effect    = "Allow"
    actions   = ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteBootstrapLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.database_bootstrap.arn}:*"]
  }

  statement {
    sid     = "ReadOnlyDatabaseBootstrapSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [local.postgres_master_secret_arn],
      [for service in values(local.database_bootstrap_services) : service.migration_secret],
      [for service in values(local.database_bootstrap_services) : service.runtime_secret],
      [local.database_bootstrap_services.indexer.reader_secret],
    )
  }

  statement {
    sid     = "DecryptOnlyDatabaseBootstrapSecrets"
    effect  = "Allow"
    actions = ["kms:Decrypt"]
    resources = [
      local.data_kms_key_arn,
      aws_kms_key.platform.arn,
    ]
  }
}

resource "aws_iam_role_policy" "database_bootstrap_execution" {
  name   = "agroasys-cotsel-staging-db-bootstrap-execution"
  role   = aws_iam_role.database_bootstrap_execution.id
  policy = data.aws_iam_policy_document.database_bootstrap_execution.json
}

resource "aws_ecs_task_definition" "database_bootstrap" {
  family                   = "${local.name_prefix}-database-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.database_bootstrap_execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "database-bootstrap"
      image                  = "public.ecr.aws/docker/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      command                = ["/bin/sh", "-ec", local.database_bootstrap_command]
      secrets = [
        { name = "MASTER_PASSWORD", valueFrom = "${local.postgres_master_secret_arn}:password::" },
        { name = "MASTER_USERNAME", valueFrom = "${local.postgres_master_secret_arn}:username::" },
        { name = "INDEXER_MIGRATION_PASSWORD", valueFrom = "${local.database_bootstrap_services.indexer.migration_secret}:password::" },
        { name = "INDEXER_MIGRATION_USERNAME", valueFrom = "${local.database_bootstrap_services.indexer.migration_secret}:username::" },
        { name = "INDEXER_RUNTIME_PASSWORD", valueFrom = "${local.database_bootstrap_services.indexer.runtime_secret}:password::" },
        { name = "INDEXER_RUNTIME_USERNAME", valueFrom = "${local.database_bootstrap_services.indexer.runtime_secret}:username::" },
        { name = "INDEXER_READER_PASSWORD", valueFrom = "${local.database_bootstrap_services.indexer.reader_secret}:password::" },
        { name = "INDEXER_READER_USERNAME", valueFrom = "${local.database_bootstrap_services.indexer.reader_secret}:username::" },
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
          awslogs-group         = aws_cloudwatch_log_group.database_bootstrap.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "bootstrap"
        }
      }
    },
  ])

  depends_on = [aws_iam_role_policy.database_bootstrap_execution]
}
