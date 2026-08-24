'use strict';

const { Pool } = require('pg');

function escapePostgresSetting(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\s/g, '\\ ');
}

function buildSessionOptions({ serviceName, connectionRole, runtimeDbUser }) {
  const settings = [
    `-c app.service_name=${escapePostgresSetting(serviceName)}`,
    `-c app.connection_role=${escapePostgresSetting(connectionRole)}`,
  ];

  if (runtimeDbUser) {
    settings.push(`-c app.runtime_db_user=${escapePostgresSetting(runtimeDbUser)}`);
  }

  return settings.join(' ');
}

function resolveMigrationCredentials(config) {
  const migrationUser = config.dbMigrationUser;
  const migrationPassword = config.dbMigrationPassword;

  if (migrationUser && migrationPassword) {
    return {
      user: migrationUser,
      password: migrationPassword,
    };
  }

  return {
    user: config.dbUser,
    password: config.dbPassword,
  };
}

function shouldAutoMigrateDatabase({ nodeEnv, rawValue }) {
  const normalized = rawValue?.trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  if (normalized) {
    throw new Error('DB_AUTO_MIGRATE must be true or false');
  }

  if (nodeEnv === 'production') {
    throw new Error('DB_AUTO_MIGRATE must be set explicitly when NODE_ENV=production');
  }

  return true;
}

function parsePostgresSslMode(value, fallback = 'disable') {
  const mode = value?.trim() || fallback;
  if (mode === 'disable' || mode === 'require' || mode === 'verify-full') {
    return mode;
  }
  throw new Error('DB_SSL_MODE must be one of disable, require, or verify-full');
}

function resolvePostgresSslConfig(mode = 'disable') {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      throw new Error(`Unsupported Postgres SSL mode: ${mode}`);
  }
}

function createServicePool({
  serviceName,
  connectionRole = 'runtime',
  runtimeDbUser,
  host,
  port,
  database,
  user,
  password,
  max = 20,
  idleTimeoutMillis = 30000,
  connectionTimeoutMillis = 2000,
  sslMode = 'disable',
}) {
  return new Pool({
    host,
    port,
    database,
    user,
    password,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    ssl: resolvePostgresSslConfig(sslMode),
    application_name: `${serviceName}-${connectionRole}`,
    options: buildSessionOptions({
      serviceName,
      connectionRole,
      runtimeDbUser: runtimeDbUser || user,
    }),
  });
}

module.exports = {
  buildSessionOptions,
  parsePostgresSslMode,
  resolvePostgresSslConfig,
  resolveMigrationCredentials,
  shouldAutoMigrateDatabase,
  createServicePool,
};
