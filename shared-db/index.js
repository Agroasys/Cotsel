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
  resolveMigrationCredentials,
  createServicePool,
};
