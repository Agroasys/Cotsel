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
const managedSigners = read('managed-signers.tf');
const oracleRuntime = read('runtime-oracle-reconciliation.tf');
const oracleService = read('oracle-service.tf');
const relayerService = read('relayer-service.tf');
const network = read('network.tf');
const runtimeImages = read('runtime-images.tf');
const gatewayPackage = readFileSync(join(root, '..', '..', 'gateway', 'package.json'), 'utf8');
const gatewayTransport = readFileSync(
  join(root, '..', '..', 'gateway', 'src', 'core', 'managedSignerTransport.ts'),
  'utf8',
);
const oracleSigner = readFileSync(
  join(root, '..', '..', 'oracle', 'src', 'blockchain', 'aws-kms-signer.ts'),
  'utf8',
);
const relayerSigner = readFileSync(
  join(root, '..', '..', 'relayer', 'src', 'kmsRelayerSigner.ts'),
  'utf8',
);

assert.doesNotMatch(gateway, /local\.oracle_container/);
assert.match(gateway, /service_discovery_service\.runtime\["gateway"\]/);
assert.match(gatewayAuth, /http:\/\/oracle\.cotsel-staging\.internal:3001/);
assert.doesNotMatch(gatewayIam, /database\/oracle\/runtime|oracle_wallet/);

assert.match(oracleRuntime, /ORACLE_KMS_EXPECTED_ADDRESS/);
assert.match(oracleRuntime, /ORACLE_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(oracleRuntime, /oracle_kms_enabled \? \[/);
assert.doesNotMatch(oracleRuntime, /ORACLE_PRIVATE_KEY|raw_private_key|oracle_wallet/);
assert.doesNotMatch(runtimeImages, /oracle_wallet/);
assert.match(oracleRuntime, /http:\/\/gateway\.cotsel-staging\.internal:4350\/graphql/);

assert.match(oracleService, /task_role_arn\s+= aws_iam_role\.oracle_task\.arn/);
assert.match(oracleService, /actions\s+= \["kms:GetPublicKey"\]/);
assert.match(oracleService, /actions\s+= \["kms:Sign"\]/);
assert.match(oracleService, /resources\s+= \[aws_kms_key\.managed_signer\["oracle"\]\.arn\]/);
assert.match(oracleService, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  oracleService,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);
assert.match(oracleService, /service_discovery_service\.runtime\["oracle"\]/);
assert.match(oracleService, /enable_execute_command\s+= false/);
assert.match(oracleService, /desired_count\s+= local\.oracle_kms_enabled && var\.gateway_desired_count > 0 \? 1 : 0/);
assert.doesNotMatch(oracleService, /oracle_wallet/);
assert.match(oracleService, /deployment_maximum_percent\s+= 100/);
assert.match(oracleService, /deployment_minimum_healthy_percent\s+= 0/);
assert.match(oracleService, /aws_ecs_service\.gateway/);

assert.match(network, /gateway_to_oracle/);
assert.match(network, /gateway_indexer_from_services/);
assert.match(network, /services_to_gateway_indexer/);

assert.match(relayerService, /task_role_arn\s+= aws_iam_role\.relayer_task\.arn/);
assert.match(relayerService, /actions\s+= \["kms:GetPublicKey"\]/);
assert.match(relayerService, /actions\s+= \["kms:Sign"\]/);
assert.match(relayerService, /resources\s+= \[aws_kms_key\.managed_signer\["relayer"\]\.arn\]/);
assert.match(relayerService, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  relayerService,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);
assert.match(relayerService, /enable_execute_command\s+= false/);
assert.match(relayerService, /gasless_execution_has_one_gateway_writer/);
assert.match(network, /gateway_to_relayer/);

assert.match(managedSigners, /DenyUnapprovedSigningPrincipal/);
assert.match(managedSigners, /ArnNotEquals/);
assert.match(managedSigners, /DenyNonDigestSigning/);
assert.match(managedSigners, /DenyUnexpectedSigningAlgorithm/);
assert.match(managedSigners, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  managedSigners,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);

assert.doesNotMatch(gatewayPackage, /@aws-sdk\/client-kms/);
assert.doesNotMatch(gatewayTransport, /KMSClient|SignCommand|KmsEvmSigner/);
assert.match(gatewayTransport, /createServiceAuthHeaders/);
for (const signer of [oracleSigner, relayerSigner]) {
  assert.match(signer, /MessageType:\s*MessageType\.DIGEST/);
  assert.match(signer, /SigningAlgorithm:\s*SigningAlgorithmSpec\.ECDSA_SHA_256/);
}

console.log('Oracle and relayer KMS workload-isolation self-test passed.');
