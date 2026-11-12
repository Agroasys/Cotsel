'use strict';

const assert = require('node:assert/strict');

/** Validate the deployment profile before a service selects runtime safeguards. */
function deploymentProfile(nodeEnv) {
  const profile = process.env.COTSEL_ENVIRONMENT?.trim().toLowerCase() || 'local';
  assert(
    ['local', 'staging', 'production'].includes(profile),
    'COTSEL_ENVIRONMENT must be one of: local, staging, production',
  );
  assert(
    profile === 'local' || nodeEnv === 'production',
    `NODE_ENV must be production when COTSEL_ENVIRONMENT=${profile}`,
  );
  return profile;
}

module.exports = { deploymentProfile };
