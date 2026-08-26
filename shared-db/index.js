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
  createServicePool,
};
