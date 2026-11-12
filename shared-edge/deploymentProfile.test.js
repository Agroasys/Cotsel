'use strict';

const { deploymentProfile } = require('./deploymentProfile');

describe('deployment profile', () => {
  const original = process.env.COTSEL_ENVIRONMENT;
  afterEach(() => {
    if (original === undefined) delete process.env.COTSEL_ENVIRONMENT;
    else process.env.COTSEL_ENVIRONMENT = original;
  });

  test.each(['staging', 'production', ' Staging ', 'PRODUCTION'])(
    '%s always requires the production runtime',
    (profile) => {
      process.env.COTSEL_ENVIRONMENT = profile;
      for (const nodeEnv of ['development', 'test', 'Production', '']) {
        expect(() => deploymentProfile(nodeEnv)).toThrow('NODE_ENV must be production');
      }
      expect(deploymentProfile('production')).toBe(profile.trim().toLowerCase());
    },
  );

  test.each(['prod', 'stage', 'preview', 'Staging Env'])(
    'rejects unsupported %s in every runtime',
    (profile) => {
      process.env.COTSEL_ENVIRONMENT = profile;
      for (const nodeEnv of ['development', 'test', 'production']) {
        expect(() => deploymentProfile(nodeEnv)).toThrow('COTSEL_ENVIRONMENT must be one of');
      }
    },
  );

  test.each([undefined, '', '  ', 'local', ' LOCAL '])(
    'retains local behavior for %s',
    (profile) => {
      if (profile === undefined) delete process.env.COTSEL_ENVIRONMENT;
      else process.env.COTSEL_ENVIRONMENT = profile;
      for (const nodeEnv of ['development', 'test', 'production']) {
        expect(deploymentProfile(nodeEnv)).toBe('local');
      }
    },
  );
});
