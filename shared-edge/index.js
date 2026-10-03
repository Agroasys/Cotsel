'use strict';

const cors = require('./cors');
const rateLimit = require('./rateLimit');
const readiness = require('./readiness');

module.exports = {
  ...cors,
  ...rateLimit,
  ...readiness,
};
