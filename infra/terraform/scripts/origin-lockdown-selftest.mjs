#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platform = join(here, '..', 'staging-platform');
const files = {
  edge: readFileSync(join(platform, 'edge.tf'), 'utf8'),
  logging: readFileSync(join(platform, 'logging.tf'), 'utf8'),
  network: readFileSync(join(platform, 'network.tf'), 'utf8'),
  versions: readFileSync(join(platform, 'versions.tf'), 'utf8'),
  waf: readFileSync(join(platform, 'waf.tf'), 'utf8'),
};

const requirements = [
  ['edge provider', files.versions, 'alias  = "edge"'],
  ['edge region', files.versions, 'region = "us-east-1"'],
  ['WAF association', files.edge, 'web_acl_id          = aws_wafv2_web_acl.gateway.arn'],
  ['HTTPS-only origin', files.edge, 'origin_protocol_policy = "https-only"'],
  ['CloudFront-only HTTPS ingress', files.network, 'from_port         = 443'],
  ['CloudFront WAF scope', files.waf, 'scope       = "CLOUDFRONT"'],
  ['edge rate blocking', files.waf, 'aggregate_key_type = "IP"'],
  ['WAF logging', files.logging, 'aws_wafv2_web_acl_logging_configuration'],
  ['CloudFront access logs', files.logging, 'aws_cloudwatch_log_delivery_source'],
  ['API-key redaction', files.logging, '"x-api-key"'],
  ['nonce redaction', files.logging, '"x-agroasys-nonce"'],
  ['signature redaction', files.logging, '"x-agroasys-signature"'],
];

let failures = 0;
for (const [name, source, expected] of requirements) {
  const passed = source.includes(expected);
  console.log(`${passed ? 'pass' : 'FAIL'} ${name}`);
  if (!passed) failures += 1;
}

for (const forbidden of ['AVD-AWS-0010', 'AVD-AWS-0011']) {
  const passed = !files.edge.includes(forbidden);
  console.log(`${passed ? 'pass' : 'FAIL'} ${forbidden} suppression removed`);
  if (!passed) failures += 1;
}

if (failures > 0) {
  process.exit(1);
}

console.log('Cotsel origin-lockdown controls are present.');
