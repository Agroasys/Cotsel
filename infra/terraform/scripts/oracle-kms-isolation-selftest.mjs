// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (name) => readFileSync(join(root, 'staging-platform', name), 'utf8');
const readFoundation = (name) => readFileSync(join(root, 'staging-foundation', name), 'utf8');

const gateway = read('gateway-runtime.tf');
const gatewayAuth = read('runtime-gateway-auth.tf');
const gatewayIam = read('iam.tf');
const indexerService = read('indexer-service.tf');
const managedSigners = read('managed-signers.tf');
const signerCustody = readFoundation('signer-custody.tf');
const runtimePrerequisites = readFoundation('runtime-prerequisites.tf');
const oracleRuntime = read('runtime-oracle-reconciliation.tf');
const oracleService = read('oracle-service.tf');
const reconciliationService = read('reconciliation-service.tf');
const relayerService = read('relayer-service.tf');
const runtimeImages = read('runtime-images.tf');
const variables = read('variables.tf');
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
assert.match(gateway, /runtime_service_discovery_arns\["gateway"\]/);
assert.doesNotMatch(
  gateway,
  /local\.indexer_(pipeline|graphql)_container|local\.reconciliation_container/,
);
assert.match(gateway, /enable_execute_command\s+= false/);
assert.match(gatewayAuth, /http:\/\/oracle\.cotsel-staging\.internal:3001/);
assert.match(gatewayAuth, /http:\/\/indexer-graphql\.cotsel-staging\.internal:4350\/graphql/);
assert.match(gatewayAuth, /http:\/\/reconciliation\.cotsel-staging\.internal:9090/);
assert.doesNotMatch(gatewayIam, /database\/oracle\/runtime|oracle_wallet/);
assert.doesNotMatch(
  gatewayIam,
  /database\/indexer\/(reader|runtime)|database\/reconciliation\/reader/,
);
assert.match(
  variables,
  /variable "gateway_desired_count"[\s\S]*?default\s+= 0[\s\S]*?variable "indexer_desired_count"[\s\S]*?default\s+= 0[\s\S]*?variable "reconciliation_desired_count"[\s\S]*?default\s+= 0[\s\S]*?variable "oracle_desired_count"[\s\S]*?default\s+= 0[\s\S]*?variable "relayer_desired_count"[\s\S]*?default\s+= 0/,
);

assert.match(oracleRuntime, /ORACLE_KMS_EXPECTED_ADDRESS/);
assert.match(oracleRuntime, /ORACLE_SIGNER_CUSTODY_MODE", value = "kms"/);
assert.match(oracleRuntime, /oracle_kms_enabled \? \[/);
assert.doesNotMatch(oracleRuntime, /ORACLE_PRIVATE_KEY|raw_private_key|oracle_wallet/);
assert.doesNotMatch(runtimeImages, /oracle_wallet/);
assert.match(oracleRuntime, /http:\/\/indexer-graphql\.cotsel-staging\.internal:4350\/graphql/);

assert.match(oracleService, /task_role_arn\s+= local\.managed_signer_task_role_arns\["oracle"\]/);
assert.match(oracleService, /actions\s+= \["kms:GetPublicKey"\]/);
assert.match(oracleService, /actions\s+= \["kms:Sign"\]/);
assert.match(oracleService, /resources\s+= \[local\.managed_signer_key_arns\["oracle"\]\]/);
assert.match(oracleService, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  oracleService,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);
assert.match(oracleService, /runtime_service_discovery_arns\["oracle"\]/);
assert.match(oracleService, /enable_execute_command\s+= false/);
assert.match(oracleService, /desired_count\s+= var\.oracle_desired_count/);
assert.match(oracleService, /oracle_activation_requires_reviewed_kms_address/);
assert.doesNotMatch(oracleService, /oracle_wallet/);
assert.match(oracleService, /deployment_maximum_percent\s+= 100/);
assert.match(oracleService, /deployment_minimum_healthy_percent\s+= 0/);
assert.match(oracleService, /aws_ecs_service\.indexer/);

assert.match(runtimePrerequisites, /gateway_to_oracle/);
assert.match(runtimePrerequisites, /gateway_to_indexer/);
assert.match(runtimePrerequisites, /services_to_indexer/);

assert.match(indexerService, /resource "aws_ecs_service" "indexer"/);
assert.match(indexerService, /desired_count\s+= var\.indexer_desired_count/);
assert.match(indexerService, /enable_execute_command\s+= false/);
assert.match(indexerService, /skip_destroy\s+= true/);
assert.match(reconciliationService, /resource "aws_ecs_service" "reconciliation"/);
assert.match(reconciliationService, /desired_count\s+= var\.reconciliation_desired_count/);
assert.match(reconciliationService, /enable_execute_command\s+= false/);
assert.match(reconciliationService, /skip_destroy\s+= true/);

assert.match(relayerService, /task_role_arn\s+= local\.managed_signer_task_role_arns\["relayer"\]/);
assert.match(relayerService, /actions\s+= \["kms:GetPublicKey"\]/);
assert.match(relayerService, /actions\s+= \["kms:Sign"\]/);
assert.match(relayerService, /resources\s+= \[local\.managed_signer_key_arns\["relayer"\]\]/);
assert.match(relayerService, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  relayerService,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);
assert.match(relayerService, /enable_execute_command\s+= false/);
assert.match(relayerService, /desired_count\s+= var\.relayer_desired_count/);
assert.match(relayerService, /relayer_activation_requires_reviewed_kms_address/);
assert.match(relayerService, /gasless_execution_has_one_gateway_writer/);
assert.match(runtimePrerequisites, /gateway_to_relayer/);

assert.match(
  managedSigners,
  /terraform_remote_state\.foundation\.outputs\.managed_signer_key_arns/,
);
assert.match(managedSigners, /foundation_exposes_only_approved_automated_signers/);
assert.doesNotMatch(managedSigners, /resource "aws_(kms|iam)_/);
assert.match(signerCustody, /DenyUnapprovedSigningPrincipal/);
assert.match(signerCustody, /ArnNotEquals/);
assert.match(signerCustody, /DenyNonDigestSigning/);
assert.match(signerCustody, /DenyUnexpectedSigningAlgorithm/);
assert.match(signerCustody, /variable\s+= "kms:MessageType"\s+values\s+= \["DIGEST"\]/s);
assert.match(
  signerCustody,
  /variable\s+= "kms:SigningAlgorithm"\s+values\s+= \["ECDSA_SHA_256"\]/s,
);
assert.match(signerCustody, /customer_master_key_spec\s+= "ECC_SECG_P256K1"/);
assert.match(signerCustody, /key_usage\s+= "SIGN_VERIFY"/);
assert.match(signerCustody, /prevent_destroy\s+= true/);
assert.doesNotMatch(signerCustody, /aws_iam_role_policy|kms:Sign"\][\s\S]*effect\s+= "Allow"/);
assert.doesNotMatch(oracleService, /resource "aws_iam_role" "oracle_task"/);
assert.doesNotMatch(relayerService, /resource "aws_iam_role" "relayer_task"/);

assert.doesNotMatch(gatewayPackage, /@aws-sdk\/client-kms/);
assert.doesNotMatch(gatewayTransport, /KMSClient|SignCommand|KmsEvmSigner/);
assert.match(gatewayTransport, /createServiceAuthHeaders/);
for (const signer of [oracleSigner, relayerSigner]) {
  assert.match(signer, /MessageType:\s*MessageType\.DIGEST/);
  assert.match(signer, /SigningAlgorithm:\s*SigningAlgorithmSpec\.ECDSA_SHA_256/);
}

console.log('Oracle and relayer KMS workload-isolation self-test passed.');
