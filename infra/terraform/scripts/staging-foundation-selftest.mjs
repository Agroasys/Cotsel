#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const terraformDirectory = join(scriptsDirectory, '..');
const repositoryRoot = join(terraformDirectory, '..', '..');

function read(path) {
  return readFileSync(path, 'utf8');
}

const foundationRegistry = read(join(terraformDirectory, 'staging-foundation', 'registry.tf'));
const foundationSignerCustody = read(
  join(terraformDirectory, 'staging-foundation', 'signer-custody.tf'),
);
const foundationOutputs = read(join(terraformDirectory, 'staging-foundation', 'outputs.tf'));
const foundationBackend = read(join(terraformDirectory, 'staging-foundation', 'backend.tf'));
const platformRegistry = read(join(terraformDirectory, 'staging-platform', 'registry.tf'));
const platformManagedSigners = read(
  join(terraformDirectory, 'staging-platform', 'managed-signers.tf'),
);
const runtimeImages = read(join(terraformDirectory, 'staging-platform', 'runtime-images.tf'));
const relayerService = read(join(terraformDirectory, 'staging-platform', 'relayer-service.tf'));
const terraformWorkflow = read(join(repositoryRoot, '.github', 'workflows', 'terraform.yml'));
const releaseWorkflow = read(join(repositoryRoot, '.github', 'workflows', 'release-images.yml'));

assert.match(foundationBackend, /cotsel\/staging-platform\/foundation\.tfstate/);
assert.match(foundationRegistry, /foundation_release_services\s*=\s*toset\(\[\s*"relayer"/s);
assert.match(foundationRegistry, /name\s*=\s*"cotsel\/\$\{each\.key\}"/);
assert.match(foundationRegistry, /image_tag_mutability\s*=\s*"IMMUTABLE"/);
assert.match(foundationRegistry, /encryption_type\s*=\s*"KMS"/);
assert.match(foundationRegistry, /scan_on_push\s*=\s*true/);
assert.match(foundationRegistry, /prevent_destroy\s*=\s*true/);
assert.match(foundationSignerCustody, /managed_signer_roles\s*=\s*local\.approved_automated_signer_roles/);
assert.match(foundationSignerCustody, /resource "aws_iam_role" "managed_signer_task"/);
assert.match(foundationSignerCustody, /resource "aws_kms_key" "managed_signer"/);
assert.match(foundationSignerCustody, /customer_master_key_spec\s*=\s*"ECC_SECG_P256K1"/);
assert.match(foundationSignerCustody, /prevent_destroy\s*=\s*true/);
assert.doesNotMatch(foundationSignerCustody, /resource "aws_iam_role_policy"/);
assert.match(foundationOutputs, /output "managed_signer_key_arns"/);
assert.match(foundationOutputs, /output "managed_signer_task_role_arns"/);
assert.doesNotMatch(platformManagedSigners, /resource "aws_(kms|iam)_/);

assert.match(platformRegistry, /setsubtract\(local\.services, toset\(\["relayer"\]\)\)/);
assert.match(runtimeImages, /terraform_remote_state\.foundation\.outputs\.ecr_repository_names/);
assert.match(runtimeImages, /terraform_remote_state\.foundation\.outputs\.ecr_repository_urls/);
assert.match(relayerService, /terraform_remote_state\.foundation\.outputs\.ecr_repository_arns/);

assert.match(terraformWorkflow, /- staging-foundation\s+- staging-platform/);
assert.match(terraformWorkflow, /plans\/cotsel-staging-platform\/\$ROOT\/\$GITHUB_RUN_ID\.tfplan/);
assert.match(releaseWorkflow, /name:\s+Verify the complete ECR repository cohort/);
assert.match(releaseWorkflow, /needs:\s+registry-ready/);

console.log('Staging foundation and release-registry split self-test passed.');
