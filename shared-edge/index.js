'use strict';

const { deploymentProfile } = require('./deploymentProfile');
const cors = require('./cors');
const rateLimit = require('./rateLimit');
const readiness = require('./readiness');

module.exports = {
  deploymentProfile,
  ...cors,
  ...rateLimit,
  ...readiness,
};
