// Settings an operator changes through .env.runtime reach the gateway only if
// docker-compose.gateway.yml forwards them. These are the rollback and policy
// switches of Cotsel#946 and #940; an unforwarded one silently keeps its default.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FORWARDED = [
  'GATEWAY_STEP_UP_MAX_AGE_SECONDS',
  'GATEWAY_STEP_UP_ACCEPTED_STRENGTHS',
  'GATEWAY_STEP_UP_ENFORCEMENT',
  'GATEWAY_TEMPLATE_ACTIVATION_ALLOWLIST',
];

test('the gateway compose service forwards its step-up and template settings', () => {
  const compose = readFileSync('docker-compose.gateway.yml', 'utf8');
  const example = readFileSync('.env.runtime.example', 'utf8');
  for (const key of FORWARDED) {
    assert.match(
      example,
      new RegExp(`^${key}=`, 'mu'),
      `${key} is not declared in .env.runtime.example`,
    );
    assert.match(
      compose,
      new RegExp(`^ {6}${key}: '\\$\\{${key}(:-[^}]*)?\\}'$`, 'mu'),
      `${key} is not forwarded by docker-compose.gateway.yml`,
    );
  }
});
