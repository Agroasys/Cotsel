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
    printf '%s\n' '{"Account":"655177116834"}'
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
      printf '%s\n' '{"BackupPlan":{"Rules":[{"Lifecycle":{"DeleteAfterDays":35},"CopyActions":[{"DestinationBackupVaultArn":"arn:aws:backup:ap-south-1:111122223333:backup-vault:recovery","Lifecycle":{"DeleteAfterDays":35}}]}]}}'
    else
      printf '%s\n' '{"BackupPlan":{"Rules":[{"Lifecycle":{"DeleteAfterDays":35}}]}}'
    fi
    ;;
  'backup list-backup-selections')
    printf '%s\n' '{"BackupSelectionsList":[{"SelectionId":"selection-1"}]}'
    ;;
  'backup get-backup-selection')
    printf '%s\n' '{"BackupSelection":{"Resources":["arn:aws:rds:ap-south-1:655177116834:db:agroasys-staging"]}}'
    ;;
  'backup describe-backup-vault')
    printf '{"BackupVaultArn":"arn:aws:backup:ap-south-1:655177116834:backup-vault:agroasys-staging","Locked":%s}\n' "\${MOCK_VAULT_LOCKED:-true}"
    ;;
  'backup list-recovery-points-by-resource')
    printf '%s\n' '{"RecoveryPoints":[{"Status":"COMPLETED","CreationDate":"2026-08-27T02:00:00Z"}]}'
    ;;
  *)
    printf 'unexpected AWS command: %s %s\n' "\${1}" "\${2}" >&2
    exit 2
    ;;
esac
`;

async function runAudit(vaultLocked, offsiteCopy = false) {
  const mockDirectory = await mkdtemp(path.join(tmpdir(), 'cotsel-recovery-audit-'));
  const awsPath = path.join(mockDirectory, 'aws');
  await writeFile(awsPath, awsMock, 'utf8');
  await chmod(awsPath, 0o755);

  try {
    return spawnSync(scriptPath, [], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOCK_VAULT_LOCKED: String(vaultLocked),
        MOCK_OFFSITE_COPY: String(offsiteCopy),
        PATH: `${mockDirectory}:${process.env.PATH}`,
      },
    });
  } finally {
    await rm(mockDirectory, { recursive: true, force: true });
  }
}

test('recovery control audit preserves explicit false booleans and passes locked off-site retention', async () => {
  const result = await runAudit(true, true);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'VERIFIED');
  assert.equal(report.database.publiclyAccessible, false);
  assert.equal(report.awsBackup.vaultLocked, true);
  assert.equal(report.awsBackup.offsiteCopyDestinations, 1);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blockers, []);
});

test('recovery control audit fails closed when AWS Backup Vault Lock is absent', async () => {
  const result = await runAudit(false);
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
  const result = await runAudit(true);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, 'PARTIALLY_VERIFIED');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blockers, [
    'immutable off-site backup custody is not configured or proven',
  ]);
});
