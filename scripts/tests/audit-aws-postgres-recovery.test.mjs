import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'audit-aws-postgres-recovery.sh');

const awsMock = `#!/usr/bin/env bash
set -euo pipefail
case "\${1} \${2}" in
  'sts get-caller-identity')
    if [[ " $* " == *' --profile offsite '* ]]; then
      printf '%s\n' '{"Account":"111122223333"}'
    else
      printf '%s\n' '{"Account":"655177116834"}'
    fi
    ;;
  'rds describe-db-instances')
    printf '%s\n' '{"DBInstances":[{"DBInstanceIdentifier":"agroasys-staging","DBInstanceStatus":"available","DBInstanceClass":"db.t4g.small","Engine":"postgres","EngineVersion":"16.13","StorageEncrypted":true,"MultiAZ":true,"PubliclyAccessible":false,"DeletionProtection":true,"BackupRetentionPeriod":7}]}'
    ;;
  'rds describe-db-instance-automated-backups')
    printf '%s\n' '{"DBInstanceAutomatedBackups":[{"Status":"active","RestoreWindow":{"EarliestTime":"2026-08-20T00:00:00Z","LatestTime":"2026-08-27T00:00:00Z"}}]}'
    ;;
  'backup list-backup-plans')
    printf '%s\n' '{"BackupPlansList":[{"BackupPlanName":"agroasys-staging-daily","BackupPlanId":"plan-1","DeletionDate":null}]}'
    ;;
  'backup get-backup-plan')
    if [[ "\${MOCK_OFFSITE_COPY:-false}" == 'true' ]]; then
      printf '%s\n' '{"VersionId":"version-1","BackupPlan":{"Rules":[{"TargetBackupVaultName":"'"\${MOCK_SOURCE_VAULT:-agroasys-staging}"'","Lifecycle":{"DeleteAfterDays":35},"CopyActions":[{"DestinationBackupVaultArn":"arn:aws:backup:ap-south-1:111122223333:backup-vault:recovery","Lifecycle":{"DeleteAfterDays":35}}]}]}}'
    else
      printf '%s\n' '{"VersionId":"version-1","BackupPlan":{"Rules":[{"TargetBackupVaultName":"'"\${MOCK_SOURCE_VAULT:-agroasys-staging}"'","Lifecycle":{"DeleteAfterDays":35}}]}}'
    fi
    ;;
  'backup list-backup-selections')
    printf '%s\n' '{"BackupSelectionsList":[{"SelectionId":"selection-1"}]}'
    ;;
  'backup get-backup-selection')
    printf '%s\n' '{"BackupSelection":{"Resources":["arn:aws:rds:ap-south-1:655177116834:db:agroasys-staging"]}}'
    ;;
  'backup describe-backup-vault')
    if [[ " $* " == *' --profile offsite '* ]]; then
      printf '{"BackupVaultArn":"arn:aws:backup:ap-south-1:111122223333:backup-vault:recovery","Locked":%s}\n' "\${MOCK_OFFSITE_VAULT_LOCKED:-true}"
    else
      printf '{"BackupVaultArn":"arn:aws:backup:ap-south-1:655177116834:backup-vault:agroasys-staging","Locked":%s}\n' "\${MOCK_VAULT_LOCKED:-true}"
    fi
    ;;
  'backup list-recovery-points-by-backup-vault')
    if [[ " $* " == *' --profile offsite '* ]]; then
      printf '%s\n' '{"RecoveryPoints":[{"RecoveryPointArn":"arn:aws:backup:ap-south-1:111122223333:recovery-point:copy-1","Status":"COMPLETED","IsEncrypted":true,"CreationDate":"__NOW__","CreatedBy":{"BackupPlanId":"plan-1"}}]}'
    else
      printf '%s\n' '{"RecoveryPoints":[{"RecoveryPointArn":"arn:aws:rds:ap-south-1:655177116834:snapshot:source-1","Status":"COMPLETED","IsEncrypted":true,"CreationDate":"__NOW__","CreatedBy":{"BackupPlanId":"plan-1"}}]}'
    fi
    ;;
  *)
    printf 'unexpected AWS command: %s %s\n' "\${1}" "\${2}" >&2
    exit 2
    ;;
esac
`;

async function runAudit({
  vaultLocked = true,
  offsiteCopy = false,
  proveOffsite = false,
  bindRecoveryObjectives = true,
  sourceVault = 'agroasys-staging',
  recoveryDate = new Date().toISOString(),
} = {}) {
  const mockDirectory = await mkdtemp(path.join(tmpdir(), 'cotsel-recovery-audit-'));
  const awsPath = path.join(mockDirectory, 'aws');
  await writeFile(awsPath, awsMock.replaceAll('__NOW__', recoveryDate), 'utf8');
  await chmod(awsPath, 0o755);

  try {
    return spawnSync(scriptPath, [], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK_VAULT_LOCKED: String(vaultLocked),
        MOCK_OFFSITE_COPY: String(offsiteCopy),
        MOCK_SOURCE_VAULT: sourceVault,
        ...(bindRecoveryObjectives
          ? { COTSEL_RECOVERY_OBJECTIVES_REFERENCE: 'backend-516-accepted-evidence' }
          : {}),
        ...(proveOffsite
          ? {
              COTSEL_OFFSITE_AWS_PROFILE: 'offsite',
              COTSEL_OFFSITE_AWS_ACCOUNT_ID: '111122223333',
              COTSEL_OFFSITE_BACKUP_VAULT_NAME: 'recovery',
            }
          : {}),
        PATH: `${mockDirectory}:${process.env.PATH}`,
      },
    });
  } finally {
    await rm(mockDirectory, { recursive: true, force: true });
  }
}

test('recovery control audit preserves explicit false booleans and passes locked off-site retention', async () => {
  const result = await runAudit({ offsiteCopy: true, proveOffsite: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'VERIFIED');
  assert.equal(report.database.publiclyAccessible, false);
  assert.equal(report.awsBackup.vaultLocked, true);
  assert.equal(report.awsBackup.offsiteCopyDestinations, 1);
  assert.equal(report.awsBackup.offsite.verified, true);
  assert.equal(report.awsBackup.offsite.completedRecoveryPoints, 1);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blockers, []);
});

test('recovery control audit fails closed when AWS Backup Vault Lock is absent', async () => {
  const result = await runAudit({ vaultLocked: false });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'MISCONFIGURED');
  assert.equal(report.database.publiclyAccessible, false);
  assert.equal(report.awsBackup.vaultLocked, false);
  assert.deepEqual(report.failures, ['AWS Backup Vault Lock is not enabled']);
  assert.deepEqual(report.blockers, [
    'immutable off-site backup custody is not configured or proven',
  ]);
});

test('recovery control audit remains partial when locked backups have no proven off-site copy', async () => {
  const result = await runAudit();
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'PARTIALLY_VERIFIED');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blockers, [
    'immutable off-site backup custody is not configured or proven',
  ]);
});

test('a declared copy action remains partial until its destination is independently proven', async () => {
  const result = await runAudit({ offsiteCopy: true });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'PARTIALLY_VERIFIED');
  assert.equal(report.awsBackup.offsite.verified, false);
  assert.deepEqual(report.blockers, [
    'off-site copy is declared but destination account, vault, and recovery point are not independently proven',
  ]);
});

test('recovery control audit rejects a plan that targets a different source vault', async () => {
  const result = await runAudit({ sourceVault: 'wrong-vault' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'MISCONFIGURED');
  assert.ok(report.failures.includes('AWS Backup plan does not target the required backup vault'));
});

test('recovery control audit rejects stale completed recovery points', async () => {
  const result = await runAudit({ recoveryDate: '2026-01-01T00:00:00Z' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'MISCONFIGURED');
  assert.ok(report.failures.includes('the latest completed AWS Backup recovery point is stale'));
});

test('recovery control audit cannot verify unapproved recovery objectives', async () => {
  const result = await runAudit({
    offsiteCopy: true,
    proveOffsite: true,
    bindRecoveryObjectives: false,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'PARTIALLY_VERIFIED');
  assert.equal(report.recoveryObjectives.bound, false);
  assert.deepEqual(report.blockers, ['approved recovery objectives are not bound to this audit']);
});
