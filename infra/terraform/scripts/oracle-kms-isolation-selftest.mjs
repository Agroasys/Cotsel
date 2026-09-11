// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (name) => readFileSync(join(root, 'staging-platform', name), 'utf8');

const gateway = read('gateway-runtime.tf');
const gatewayAuth = read('runtime-gateway-auth.tf');
const gatewayIam = read('iam.tf');
const oracleRuntime = read('runtime-oracle-reconciliation.tf');
const oracleService = read('oracle-service.tf');
const network = read('network.tf');

assert.doesNotMatch(gateway, /local\.oracle_container/);
assert.match(gateway, /service_discovery_service\.runtime\["gateway"\]/);
assert.match(gatewayAuth, /http:\/\/oracle\.cotsel-staging\.internal:3001/);
assert.doesNotMatch(gatewayIam, /database\/oracle\/runtime|oracle_wallet/);

assert.match(oracleRuntime, /ORACLE_KMS_EXPECTED_ADDRESS/);
assert.match(oracleRuntime, /ORACLE_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(oracleRuntime, /oracle_kms_enabled \? \[\] : \[/);
assert.match(oracleRuntime, /http:\/\/gateway\.cotsel-staging\.internal:4350\/graphql/);

assert.match(oracleService, /task_role_arn\s+= aws_iam_role\.oracle_task\.arn/);
assert.match(oracleService, /actions\s+= \[\s*"kms:GetPublicKey",\s*"kms:Sign",?\s*\]/s);
assert.match(oracleService, /resources\s+= \[aws_kms_key\.managed_signer\["oracle"\]\.arn\]/);
assert.match(oracleService, /service_discovery_service\.runtime\["oracle"\]/);
assert.match(oracleService, /deployment_maximum_percent\s+= 100/);
assert.match(oracleService, /deployment_minimum_healthy_percent\s+= 0/);
assert.match(oracleService, /aws_ecs_service\.gateway/);

assert.match(network, /gateway_to_oracle/);
assert.match(network, /gateway_indexer_from_services/);
assert.match(network, /services_to_gateway_indexer/);

console.log('Oracle KMS workload-isolation self-test passed.');
