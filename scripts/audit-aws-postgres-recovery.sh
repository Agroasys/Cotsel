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
readonly maximum_recovery_point_age_hours="${COTSEL_MAXIMUM_RECOVERY_POINT_AGE_HOURS:-48}"
readonly recovery_objectives_reference="${COTSEL_RECOVERY_OBJECTIVES_REFERENCE:-}"
readonly offsite_profile="${COTSEL_OFFSITE_AWS_PROFILE:-}"
readonly offsite_account_id="${COTSEL_OFFSITE_AWS_ACCOUNT_ID:-}"
readonly offsite_region="${COTSEL_OFFSITE_AWS_REGION:-${aws_region}}"
readonly offsite_vault_name="${COTSEL_OFFSITE_BACKUP_VAULT_NAME:-}"

if [[ "${aws_region}" != 'ap-south-1' ]]; then
  echo 'Cotsel staging recovery controls must be audited in ap-south-1.' >&2
  exit 1
fi

for command_name in aws jq node; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

for integer_name in minimum_native_retention_days minimum_vault_retention_days maximum_recovery_point_age_hours; do
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

matching_plans="$(jq -c --arg name "${backup_plan_name}" \
  '[.BackupPlansList[]? | select(.BackupPlanName == $name and (.DeletionDate == null))]' \
  <<<"${plans_json}")"
matching_plan_count="$(jq -r 'length' <<<"${matching_plans}")"
if [[ "${matching_plan_count}" != '1' ]]; then
  echo "Expected exactly one active AWS Backup plan named ${backup_plan_name}." >&2
  exit 1
fi
backup_plan_id="$(jq -r '.[0].BackupPlanId' <<<"${matching_plans}")"

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

recovery_points_json="$(aws backup list-recovery-points-by-backup-vault \
  --profile "${aws_profile}" \
  --region "${aws_region}" \
  --backup-vault-name "${backup_vault_name}" \
  --by-resource-arn "${db_instance_arn}" \
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
plan_version_id="$(jq -r '.VersionId // empty' <<<"${backup_plan_json}")"
source_vault_rule_count="$(jq -r --arg vault "${backup_vault_name}" \
  '[.BackupPlan.Rules[]? | select(.TargetBackupVaultName == $vault)] | length' \
  <<<"${backup_plan_json}")"
plan_retention_days="$(jq -r --arg vault "${backup_vault_name}" \
  '[.BackupPlan.Rules[]? | select(.TargetBackupVaultName == $vault) | .Lifecycle.DeleteAfterDays // 0] | max // 0' \
  <<<"${backup_plan_json}")"
completed_source_recovery_points="$(jq -c --arg plan "${backup_plan_id}" \
  '[.RecoveryPoints[]?
    | select(.Status == "COMPLETED")
    | select(.IsEncrypted == true)
    | select(.CreatedBy.BackupPlanId == $plan)]' \
  <<<"${recovery_points_json}")"
latest_recovery_point="$(jq -r 'sort_by(.CreationDate) | last | .CreationDate // empty' \
  <<<"${completed_source_recovery_points}")"
latest_recovery_point_arn="$(jq -r 'sort_by(.CreationDate) | last | .RecoveryPointArn // empty' \
  <<<"${completed_source_recovery_points}")"
completed_recovery_points="$(jq -r 'length' <<<"${completed_source_recovery_points}")"
latest_recovery_point_age_hours=-1
if [[ -n "${latest_recovery_point}" ]]; then
  latest_recovery_point_age_hours="$(node -e '
    const timestamp = Date.parse(process.argv[1]);
    if (!Number.isFinite(timestamp)) process.exit(1);
    process.stdout.write(String(Math.floor((Date.now() - timestamp) / 3600000)));
  ' "${latest_recovery_point}")"
fi
offsite_copy_actions="$(jq -c --arg account "${caller_account}" \
  '[.BackupPlan.Rules[]?.CopyActions[]?
    | select((.DestinationBackupVaultArn | split(":")[4]) != $account)]' \
  <<<"${backup_plan_json}")"
offsite_copy_destinations="$(jq -r 'length' <<<"${offsite_copy_actions}")"

failures=()
blockers=()

if [[ -z "${recovery_objectives_reference}" ]]; then
  blockers+=('approved recovery objectives are not bound to this audit')
fi

offsite_verified='false'
offsite_vault_locked='false'
offsite_completed_recovery_points=0
offsite_latest_recovery_point=''
offsite_latest_recovery_point_time=''
offsite_latest_recovery_point_age_hours=-1
offsite_copy_retention_days=0

if ((offsite_copy_destinations == 0)); then
  blockers+=('immutable off-site backup custody is not configured or proven')
elif [[ -z "${offsite_profile}" || -z "${offsite_account_id}" || -z "${offsite_vault_name}" ]]; then
  blockers+=('off-site copy is declared but destination account, vault, and recovery point are not independently proven')
elif [[ "${offsite_account_id}" == "${caller_account}" ]]; then
  blockers+=('off-site backup destination must use a separate approved account')
else
  readonly expected_offsite_vault_arn="arn:aws:backup:${offsite_region}:${offsite_account_id}:backup-vault:${offsite_vault_name}"
  matching_offsite_action_count="$(jq -r --arg arn "${expected_offsite_vault_arn}" \
    '[.[] | select(.DestinationBackupVaultArn == $arn)] | length' \
    <<<"${offsite_copy_actions}")"
  offsite_copy_retention_days="$(jq -r --arg arn "${expected_offsite_vault_arn}" \
    '[.[] | select(.DestinationBackupVaultArn == $arn) | .Lifecycle.DeleteAfterDays // 0] | max // 0' \
    <<<"${offsite_copy_actions}")"

  if [[ "${matching_offsite_action_count}" != '1' ]]; then
    blockers+=('the approved off-site vault does not match exactly one backup-plan copy action')
  elif ((offsite_copy_retention_days < minimum_vault_retention_days)); then
    blockers+=('off-site backup retention is below the required minimum')
  elif ! offsite_caller_json="$(aws sts get-caller-identity \
    --profile "${offsite_profile}" \
    --region "${offsite_region}" \
    --no-cli-pager \
    --output json 2>/dev/null)"; then
    blockers+=('the off-site backup account cannot be queried with the approved profile')
  elif [[ "$(jq -r '.Account // empty' <<<"${offsite_caller_json}")" != "${offsite_account_id}" ]]; then
    blockers+=('the off-site backup profile resolves to the wrong account')
  elif ! offsite_vault_json="$(aws backup describe-backup-vault \
    --profile "${offsite_profile}" \
    --region "${offsite_region}" \
    --backup-vault-name "${offsite_vault_name}" \
    --no-cli-pager \
    --output json 2>/dev/null)"; then
    blockers+=('the approved off-site backup vault cannot be queried')
  elif ! offsite_recovery_points_json="$(aws backup list-recovery-points-by-backup-vault \
    --profile "${offsite_profile}" \
    --region "${offsite_region}" \
    --backup-vault-name "${offsite_vault_name}" \
    --by-resource-arn "${db_instance_arn}" \
    --no-cli-pager \
    --output json 2>/dev/null)"; then
    blockers+=('the approved off-site recovery points cannot be queried')
  else
    offsite_vault_locked="$(jq -r 'if has("Locked") then .Locked else false end' \
      <<<"${offsite_vault_json}")"
    offsite_completed_recovery_points="$(jq -r --arg plan "${backup_plan_id}" \
      '[.RecoveryPoints[]?
        | select(.Status == "COMPLETED")
        | select(.IsEncrypted == true)
        | select(.CreatedBy.BackupPlanId == $plan)]
       | length' \
      <<<"${offsite_recovery_points_json}")"
    offsite_latest_recovery_point="$(jq -r --arg plan "${backup_plan_id}" \
      '[.RecoveryPoints[]?
        | select(.Status == "COMPLETED")
        | select(.IsEncrypted == true)
        | select(.CreatedBy.BackupPlanId == $plan)]
       | sort_by(.CreationDate) | last | .RecoveryPointArn // empty' \
      <<<"${offsite_recovery_points_json}")"
    offsite_latest_recovery_point_time="$(jq -r --arg plan "${backup_plan_id}" \
      '[.RecoveryPoints[]?
        | select(.Status == "COMPLETED")
        | select(.IsEncrypted == true)
        | select(.CreatedBy.BackupPlanId == $plan)]
       | sort_by(.CreationDate) | last | .CreationDate // empty' \
      <<<"${offsite_recovery_points_json}")"
    if [[ -n "${offsite_latest_recovery_point_time}" ]]; then
      offsite_latest_recovery_point_age_hours="$(node -e '
        const timestamp = Date.parse(process.argv[1]);
        if (!Number.isFinite(timestamp)) process.exit(1);
        process.stdout.write(String(Math.floor((Date.now() - timestamp) / 3600000)));
      ' "${offsite_latest_recovery_point_time}")"
    fi

    if [[ "${offsite_vault_locked}" != 'true' ]]; then
      blockers+=('the approved off-site backup vault is not locked')
    elif ((offsite_completed_recovery_points == 0)); then
      blockers+=('no completed encrypted off-site recovery point exists for the active backup plan')
    elif ((offsite_latest_recovery_point_age_hours < 0 || offsite_latest_recovery_point_age_hours > maximum_recovery_point_age_hours)); then
      blockers+=('the latest completed off-site recovery point is stale')
    else
      offsite_verified='true'
    fi
  fi
fi

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
((source_vault_rule_count > 0)) || failures+=('AWS Backup plan does not target the required backup vault')
((plan_retention_days >= minimum_vault_retention_days)) || failures+=('AWS Backup retention is below the required minimum')
((completed_recovery_points > 0)) || failures+=('no completed AWS Backup recovery point exists')
((latest_recovery_point_age_hours >= 0 && latest_recovery_point_age_hours <= maximum_recovery_point_age_hours)) || failures+=('the latest completed AWS Backup recovery point is stale')
[[ "${vault_account_id}" == "${caller_account}" ]] || failures+=('the source backup vault is not in the staging account')
[[ "${vault_locked}" == 'true' ]] || failures+=('AWS Backup Vault Lock is not enabled')

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
  --arg backupPlanVersionId "${plan_version_id}" \
  --arg backupVaultName "${backup_vault_name}" \
  --arg backupVaultAccountId "${vault_account_id}" \
  --arg latestRecoveryPoint "${latest_recovery_point}" \
  --arg latestRecoveryPointArn "${latest_recovery_point_arn}" \
  --arg offsiteAccountId "${offsite_account_id}" \
  --arg offsiteRegion "${offsite_region}" \
  --arg offsiteVaultName "${offsite_vault_name}" \
  --arg offsiteLatestRecoveryPointArn "${offsite_latest_recovery_point}" \
  --arg recoveryObjectivesReference "${recovery_objectives_reference}" \
  --argjson encrypted "${encrypted}" \
  --argjson multiAz "${multi_az}" \
  --argjson publiclyAccessible "${publicly_accessible}" \
  --argjson deletionProtection "${deletion_protection}" \
  --argjson nativeRetentionDays "${native_retention_days}" \
  --argjson minimumNativeRetentionDays "${minimum_native_retention_days}" \
  --argjson minimumVaultRetentionDays "${minimum_vault_retention_days}" \
  --argjson maximumRecoveryPointAgeHours "${maximum_recovery_point_age_hours}" \
  --argjson planRetentionDays "${plan_retention_days}" \
  --argjson sourceVaultRuleCount "${source_vault_rule_count}" \
  --argjson completedRecoveryPoints "${completed_recovery_points}" \
  --argjson latestRecoveryPointAgeHours "${latest_recovery_point_age_hours}" \
  --argjson offsiteCopyDestinations "${offsite_copy_destinations}" \
  --argjson offsiteCopyRetentionDays "${offsite_copy_retention_days}" \
  --argjson offsiteVaultLocked "${offsite_vault_locked}" \
  --argjson offsiteCompletedRecoveryPoints "${offsite_completed_recovery_points}" \
  --argjson offsiteLatestRecoveryPointAgeHours "${offsite_latest_recovery_point_age_hours}" \
  --argjson offsiteVerified "${offsite_verified}" \
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
      planVersionId: $backupPlanVersionId,
      planRetentionDays: $planRetentionDays,
      sourceVaultRuleCount: $sourceVaultRuleCount,
      vaultName: $backupVaultName,
      vaultAccountId: $backupVaultAccountId,
      sameAccountVault: $sameAccountVault,
      vaultLocked: $vaultLocked,
      offsiteCopyDestinations: $offsiteCopyDestinations,
      completedRecoveryPoints: $completedRecoveryPoints,
      latestRecoveryPoint: $latestRecoveryPoint,
      latestRecoveryPointArn: $latestRecoveryPointArn,
      latestRecoveryPointAgeHours: $latestRecoveryPointAgeHours,
      offsite: {
        accountId: $offsiteAccountId,
        region: $offsiteRegion,
        vaultName: $offsiteVaultName,
        copyRetentionDays: $offsiteCopyRetentionDays,
        vaultLocked: $offsiteVaultLocked,
        completedRecoveryPoints: $offsiteCompletedRecoveryPoints,
        latestRecoveryPointArn: $offsiteLatestRecoveryPointArn,
        latestRecoveryPointAgeHours: $offsiteLatestRecoveryPointAgeHours,
        verified: $offsiteVerified
      }
    },
    recoveryObjectives: {
      reference: $recoveryObjectivesReference,
      minimumNativeRetentionDays: $minimumNativeRetentionDays,
      minimumVaultRetentionDays: $minimumVaultRetentionDays,
      maximumRecoveryPointAgeHours: $maximumRecoveryPointAgeHours,
      bound: ($recoveryObjectivesReference != "")
    },
    failures: $failures,
    blockers: $blockers
  }'

if ((${#failures[@]} > 0 || ${#blockers[@]} > 0)); then
  exit 1
fi
