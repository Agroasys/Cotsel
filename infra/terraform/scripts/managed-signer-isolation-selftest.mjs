// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const terraformRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'staging-platform');
const repositoryRoot = join(terraformRoot, '..', '..', '..');
const readTerraform = (name) => readFileSync(join(terraformRoot, name), 'utf8');
const readRepository = (name) => readFileSync(join(repositoryRoot, name), 'utf8');

const gateway = readTerraform('gateway-runtime.tf');
const gatewayAuth = readTerraform('runtime-gateway-auth.tf');
const gatewayIam = readTerraform('iam.tf');
const managedSigners = readTerraform('managed-signers.tf');
const network = readTerraform('network.tf');
const oracleRuntime = readTerraform('runtime-oracle-reconciliation.tf');
const oracleService = readTerraform('oracle-service.tf');
const relayerService = readTerraform('relayer-service.tf');
const gatewayTransport = readRepository('gateway/src/core/managedSignerTransport.ts');

assert.doesNotMatch(gateway, /local\.oracle_container|local\.relayer_container/);
assert.match(gateway, /service_discovery_service\.runtime\["gateway"\]/);
assert.match(gatewayAuth, /http:\/\/oracle\.cotsel-staging\.internal:3001/);
assert.match(gatewayAuth, /http:\/\/relayer\.cotsel-staging\.internal:3300/);
assert.match(gatewayAuth, /GATEWAY_GASLESS_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(gatewayAuth, /GATEWAY_GASLESS_MANAGED_SIGNER_API_SECRET/);
assert.doesNotMatch(gatewayAuth, /GATEWAY_GASLESS_KMS_KEY_ID/);
assert.doesNotMatch(
  gatewayIam,
  /database\/oracle\/runtime|oracle_wallet|kms:Sign|kms:GetPublicKey/,
);
assert.doesNotMatch(gatewayTransport, /@aws-sdk\/client-kms|KMSClient|SignCommand/);

assert.match(oracleRuntime, /ORACLE_KMS_EXPECTED_ADDRESS/);
assert.match(oracleRuntime, /ORACLE_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(oracleRuntime, /oracle_kms_enabled \? \[\] : \[/);
assert.match(oracleRuntime, /http:\/\/gateway\.cotsel-staging\.internal:4350\/graphql/);
assert.match(oracleService, /task_role_arn\s+= aws_iam_role\.oracle_task\.arn/);
assert.match(oracleService, /actions\s+= \[\s*"kms:GetPublicKey",\s*"kms:Sign",?\s*\]/s);
assert.match(oracleService, /resources\s+= \[aws_kms_key\.managed_signer\["oracle"\]\.arn\]/);
assert.doesNotMatch(oracleService, /managed_signer\["relayer"\]/);

assert.match(relayerService, /task_role_arn\s+= aws_iam_role\.relayer_task\.arn/);
assert.match(relayerService, /actions\s+= \["kms:GetPublicKey", "kms:Sign"\]/);
assert.match(relayerService, /resources\s+= \[aws_kms_key\.managed_signer\["relayer"\]\.arn\]/);
assert.doesNotMatch(relayerService, /managed_signer\["oracle"\]/);
assert.match(relayerService, /RELAYER_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(relayerService, /RELAYER_KMS_KEY_ID/);
assert.match(relayerService, /RELAYER_KMS_EXPECTED_ADDRESS/);
assert.match(relayerService, /desired_count\s+= local\.relayer_kms_enabled \? 1 : 0/);

assert.match(managedSigners, /managed_signer_roles = toset\(\[\s*"oracle",\s*"relayer",?\s*\]\)/s);
assert.doesNotMatch(
  managedSigners,
  /managed_signer_roles = toset\([^)]*(admin-|treasury|deployer)/s,
);
assert.match(managedSigners, /sid\s+= "DenyUnapprovedSigning"/);
assert.match(managedSigners, /test\s+= "ArnNotEquals"/);
assert.match(managedSigners, /values\s+= \[local\.managed_signer_task_role_arns\[each\.key\]\]/);
const signControlFiles = readdirSync(terraformRoot)
  .filter((name) => name.endsWith('.tf'))
  .filter((name) => readTerraform(name).includes('"kms:Sign"'))
  .sort();
assert.deepEqual(signControlFiles, [
  'managed-signers.tf',
  'oracle-service.tf',
  'relayer-service.tf',
]);

assert.match(network, /gateway_to_oracle/);
assert.match(network, /gateway_to_relayer/);
assert.match(network, /gateway_indexer_from_services/);
assert.match(network, /services_to_gateway_indexer/);

console.log('Managed signer workload-isolation self-test passed.');
