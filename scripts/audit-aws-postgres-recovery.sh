#!/usr/bin/env bash
set -euo pipefail

readonly aws_profile="${AWS_PROFILE:-agroasys}"
readonly aws_region="${AWS_REGION:-ap-south-1}"
readonly expected_account_id="${COTSEL_AWS_ACCOUNT_ID:-655177116834}"
readonly db_instance_id="${COTSEL_POSTGRES_INSTANCE_ID:-agroasys-staging}"
readonly backup_plan_name="${COTSEL_BACKUP_PLAN_NAME:-agroasys-staging-daily}"
readonly backup_vault_name="${COTSEL_BACKUP_VAULT_NAME:-agroasys-staging}"
readonly minimum_native_retention_days="${COTSEL_MINIMUM_NATIVE_BACKUP_DAYS:-7}"
readonly minimum_vault_retention_days="${COTSEL_MINIMUM_VAULT_BACKUP_DAYS:-35}"

if [[ "${aws_region}" != 'ap-south-1' ]]; then
  echo 'Cotsel staging recovery controls must be audited in ap-south-1.' >&2
  exit 1
fi

for command_name in aws jq; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

for integer_name in minimum_native_retention_days minimum_vault_retention_days; do
  integer_value="${!integer_name}"
  if [[ ! "${integer_value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${integer_name} must be a positive integer." >&2
    exit 1
  fi
done

caller_json="$(aws sts get-caller-identity \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --no-cli-pager \
  --output json)"
caller_account="$(jq -r '.Account // empty' <<<"${caller_json}")"
if [[ "${caller_account}" != "${expected_account_id}" ]]; then
  echo 'Use the approved Agroasys staging AWS account.' >&2
  exit 1
fi

instance_json="$(aws rds describe-db-instances \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --db-instance-identifier "${db_instance_id}" \
  --no-cli-pager \
  --output json)"
automated_backup_json="$(aws rds describe-db-instance-automated-backups \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --db-instance-identifier "${db_instance_id}" \
  --no-cli-pager \
  --output json)"
plans_json="$(aws backup list-backup-plans \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --no-cli-pager \
  --output json)"

backup_plan_id="$(jq -r --arg name "${backup_plan_name}" \
  '.BackupPlansList[]? | select(.BackupPlanName == $name and (.DeletionDate == null)) | .BackupPlanId' \
  <<<"${plans_json}" | head -n 1)"
if [[ -z "${backup_plan_id}" ]]; then
  echo "The required AWS Backup plan does not exist: ${backup_plan_name}" >&2
  exit 1
fi

backup_plan_json="$(aws backup get-backup-plan \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --backup-plan-id "${backup_plan_id}" \
  --no-cli-pager \
  --output json)"
selections_json="$(aws backup list-backup-selections \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --backup-plan-id "${backup_plan_id}" \
  --no-cli-pager \
  --output json)"
vault_json="$(aws backup describe-backup-vault \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --backup-vault-name "${backup_vault_name}" \
  --no-cli-pager \
  --output json)"

readonly db_instance_arn="arn:aws:rds:${aws_region}:${expected_account_id}:db:${db_instance_id}"
selection_matches_resource='false'
while IFS= read -r selection_id; do
  [[ -n "${selection_id}" ]] || continue
  selection_json="$(aws backup get-backup-selection \
    --profile "${aws_profile}" \
    --region "${aws_region}" \
    --backup-plan-id "${backup_plan_id}" \
    --selection-id "${selection_id}" \
    --no-cli-pager \
    --output json)"
  if jq -e --arg arn "${db_instance_arn}" '.BackupSelection.Resources // [] | index($arn)' \
    <<<"${selection_json}" >/dev/null; then
    selection_matches_resource='true'
    break
  fi
done < <(jq -r '.BackupSelectionsList[]?.SelectionId' <<<"${selections_json}")

recovery_points_json="$(aws backup list-recovery-points-by-resource \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --resource-arn "${db_instance_arn}" \
  --no-cli-pager \
  --output json)"

instance="$(jq -c '.DBInstances[0] // {}' <<<"${instance_json}")"
automated_backup="$(jq -c '.DBInstanceAutomatedBackups[0] // {}' <<<"${automated_backup_json}")"

engine="$(jq -r '.Engine // empty' <<<"${instance}")"
engine_version="$(jq -r '.EngineVersion // empty' <<<"${instance}")"
instance_class="$(jq -r '.DBInstanceClass // empty' <<<"${instance}")"
status="$(jq -r '.DBInstanceStatus // empty' <<<"${instance}")"
native_retention_days="$(jq -r '.BackupRetentionPeriod // 0' <<<"${instance}")"
encrypted="$(jq -r 'if has("StorageEncrypted") then .StorageEncrypted else false end' <<<"${instance}")"
multi_az="$(jq -r 'if has("MultiAZ") then .MultiAZ else false end' <<<"${instance}")"
publicly_accessible="$(jq -r 'if has("PubliclyAccessible") then .PubliclyAccessible else true end' <<<"${instance}")"
deletion_protection="$(jq -r 'if has("DeletionProtection") then .DeletionProtection else false end' <<<"${instance}")"
automated_backup_status="$(jq -r '.Status // empty' <<<"${automated_backup}")"
earliest_restorable_time="$(jq -r '.RestoreWindow.EarliestTime // empty' <<<"${automated_backup}")"
latest_restorable_time="$(jq -r '.RestoreWindow.LatestTime // empty' <<<"${automated_backup}")"
vault_locked="$(jq -r 'if has("Locked") then .Locked else false end' <<<"${vault_json}")"
vault_account_id="$(jq -r '.BackupVaultArn // "" | split(":")[4] // empty' <<<"${vault_json}")"
latest_recovery_point="$(jq -r \
  '[.RecoveryPoints[]? | select(.Status == "COMPLETED")] | sort_by(.CreationDate) | last | .CreationDate // empty' \
  <<<"${recovery_points_json}")"
completed_recovery_points="$(jq -r '[.RecoveryPoints[]? | select(.Status == "COMPLETED")] | length' \
  <<<"${recovery_points_json}")"
plan_retention_days="$(jq -r '[.BackupPlan.Rules[]?.Lifecycle.DeleteAfterDays // 0] | max // 0' \
  <<<"${backup_plan_json}")"
offsite_copy_destinations="$(jq -r --arg account "${caller_account}" \
  '[.BackupPlan.Rules[]?.CopyActions[]?
    | select((.DestinationBackupVaultArn | split(":")[4]) != $account)
    | select((.Lifecycle.DeleteAfterDays // 0) >= 1)]
   | length' \
  <<<"${backup_plan_json}")"

failures=()
[[ "${engine}" == 'postgres' ]] || failures+=('database engine is not PostgreSQL')
[[ "${status}" == 'available' ]] || failures+=('database instance is not available')
[[ "${encrypted}" == 'true' ]] || failures+=('database storage is not encrypted')
[[ "${multi_az}" == 'true' ]] || failures+=('database instance is not Multi-AZ')
[[ "${publicly_accessible}" == 'false' ]] || failures+=('database instance is publicly accessible')
[[ "${deletion_protection}" == 'true' ]] || failures+=('database deletion protection is disabled')
((native_retention_days >= minimum_native_retention_days)) || failures+=('native backup retention is below the required minimum')
[[ "${automated_backup_status}" == 'active' ]] || failures+=('native automated backup is not active')
[[ -n "${earliest_restorable_time}" && -n "${latest_restorable_time}" ]] || failures+=('native PITR restore window is incomplete')
[[ "${selection_matches_resource}" == 'true' ]] || failures+=('AWS Backup plan does not select the database instance')
((plan_retention_days >= minimum_vault_retention_days)) || failures+=('AWS Backup retention is below the required minimum')
((completed_recovery_points > 0)) || failures+=('no completed AWS Backup recovery point exists')
[[ "${vault_locked}" == 'true' ]] || failures+=('AWS Backup Vault Lock is not enabled')

blockers=()
((offsite_copy_destinations > 0)) || blockers+=('immutable off-site backup custody is not configured or proven')

if ((${#failures[@]} == 0)); then
  failures_json='[]'
else
  failures_json="$(printf '%s\n' "${failures[@]}" | jq -R . | jq -s .)"
fi
if ((${#blockers[@]} == 0)); then
  blockers_json='[]'
else
  blockers_json="$(printf '%s\n' "${blockers[@]}" | jq -R . | jq -s .)"
fi

jq -n \
  --arg generatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg accountId "${caller_account}" \
  --arg region "${aws_region}" \
  --arg dbInstanceIdentifier "${db_instance_id}" \
  --arg dbInstanceArn "${db_instance_arn}" \
  --arg engine "${engine}" \
  --arg engineVersion "${engine_version}" \
  --arg instanceClass "${instance_class}" \
  --arg earliestRestorableTime "${earliest_restorable_time}" \
  --arg latestRestorableTime "${latest_restorable_time}" \
  --arg backupPlanId "${backup_plan_id}" \
  --arg backupPlanName "${backup_plan_name}" \
  --arg backupVaultName "${backup_vault_name}" \
  --arg backupVaultAccountId "${vault_account_id}" \
  --arg latestRecoveryPoint "${latest_recovery_point}" \
  --argjson encrypted "${encrypted}" \
  --argjson multiAz "${multi_az}" \
  --argjson publiclyAccessible "${publicly_accessible}" \
  --argjson deletionProtection "${deletion_protection}" \
  --argjson nativeRetentionDays "${native_retention_days}" \
  --argjson planRetentionDays "${plan_retention_days}" \
  --argjson completedRecoveryPoints "${completed_recovery_points}" \
  --argjson offsiteCopyDestinations "${offsite_copy_destinations}" \
  --argjson vaultLocked "${vault_locked}" \
  --argjson sameAccountVault "$([[ "${vault_account_id}" == "${caller_account}" ]] && printf true || printf false)" \
  --argjson failures "${failures_json}" \
  --argjson blockers "${blockers_json}" \
  '{
    reportVersion: 1,
    generatedAt: $generatedAt,
    classification: (
      if ($failures | length) > 0 then "MISCONFIGURED"
      elif ($blockers | length) > 0 then "PARTIALLY_VERIFIED"
      else "VERIFIED"
      end
    ),
    accountId: $accountId,
    region: $region,
    database: {
      identifier: $dbInstanceIdentifier,
      arn: $dbInstanceArn,
      engine: $engine,
      engineVersion: $engineVersion,
      instanceClass: $instanceClass,
      encrypted: $encrypted,
      multiAz: $multiAz,
      publiclyAccessible: $publiclyAccessible,
      deletionProtection: $deletionProtection,
      nativeRetentionDays: $nativeRetentionDays,
      earliestRestorableTime: $earliestRestorableTime,
      latestRestorableTime: $latestRestorableTime
    },
    awsBackup: {
      planId: $backupPlanId,
      planName: $backupPlanName,
      planRetentionDays: $planRetentionDays,
      vaultName: $backupVaultName,
      vaultAccountId: $backupVaultAccountId,
      sameAccountVault: $sameAccountVault,
      vaultLocked: $vaultLocked,
      offsiteCopyDestinations: $offsiteCopyDestinations,
      completedRecoveryPoints: $completedRecoveryPoints,
      latestRecoveryPoint: $latestRecoveryPoint
    },
    failures: $failures,
    blockers: $blockers
  }'

if ((${#failures[@]} > 0 || ${#blockers[@]} > 0)); then
  exit 1
fi
