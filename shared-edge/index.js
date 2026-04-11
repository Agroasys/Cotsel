'use strict';

const cors = require('./cors');
const rateLimit = require('./rateLimit');

module.exports = {
  ...cors,
  ...rateLimit,
};
