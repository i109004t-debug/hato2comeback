#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:-}"
check_stack
[[ $# -le 2 ]] || die 'Usage: restore-table.sh ENV [RESTORE_POINT_ISO8601|latest]'
point=${2:-latest}
if [[ $point != latest ]]; then
  [[ $point =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] || die 'Invalid restore point'
  epoch=$(date -u -d "$point" +%s) || die 'Invalid restore point'
  [[ $epoch -le $(date -u +%s) ]] || die 'Restore point is in the future'
fi
config=$(aws_text ssm get-parameter --region "$REGION" --name "/ht2/$ENV/config" --query Parameter.Value --output text)
configuration=$(output ConfigurationSetName)
enabled=$(aws_text sesv2 get-configuration-set --region "$REGION" --configuration-set-name "$configuration" --query SendingOptions.SendingEnabled --output text)
if [[ ! $config =~ \"sending_enabled\"[[:space:]]*:[[:space:]]*false || $enabled != False && $enabled != false ]]; then
  printf 'Stop first: set sending_enabled=false in SSM /ht2/%s/config, preserving the other settings.\n' "$ENV" >&2
  printf 'aws sesv2 put-configuration-set-sending-options --region %s --configuration-set-name %s --no-sending-enabled\n' "$REGION" "$configuration" >&2
  die 'Sending must explicitly be disabled in both places; no restore was started'
fi
machine=$(output StateMachineArn)
mkdir -p build
runs=$(aws_text stepfunctions list-executions --region "$REGION" --state-machine-arn "$machine" --status-filter RUNNING --query 'executions[].executionArn' --output text)
printf '%s\n' "$runs" | tr '\t' '\n' | sed '/^$/d' > "build/$ENV.restore-running.txt"
cat "build/$ENV.restore-running.txt"
if [[ -s build/$ENV.restore-running.txt ]]; then
  wait_input 'Stop all listed executions? Enter: stop ACCOUNT ENV' "stop $HT2_ACCOUNT_ID $ENV"
  while IFS= read -r arn; do
    [[ $arn == "arn:aws:states:$REGION:$HT2_ACCOUNT_ID:execution:ht2-$ENV:"* ]] || die 'Unexpected execution ARN'
    aws_text stepfunctions stop-execution --region "$REGION" --execution-arn "$arn" --error RestoreRequested > /dev/null
  done < "build/$ENV.restore-running.txt"
fi
running=$(aws_text stepfunctions list-executions --region "$REGION" --state-machine-arn "$machine" --status-filter RUNNING --query 'length(executions)' --output text)
[[ $running == 0 ]] || die 'Executions are still running; wait and inspect them before restoring'
source_table=$(output TableName)
restore_id=$(date -u +%Y%m%d%H%M)
target="ht2-$ENV-restore-$restore_id"
wait_input "Restore $source_table to $target at $point? Enter: restore ACCOUNT ENV" "restore $HT2_ACCOUNT_ID $ENV"
args=(--source-table-name "$source_table" --target-table-name "$target")
if [[ $point == latest ]]; then args+=(--use-latest-restorable-time); else args+=(--restore-date-time "$point"); fi
aws_text dynamodb restore-table-to-point-in-time --region "$REGION" "${args[@]}" --output json > "build/$ENV.restore-table.json"
aws_text dynamodb wait table-exists --region "$REGION" --table-name "$target"
actual_point=$(aws_text dynamodb describe-table --region "$REGION" --table-name "$target" --query Table.RestoreSummary.RestoreDateTime --output text)
actual_point=$(date -u -d "$actual_point" +%Y-%m-%dT%H:%M:%S.%3NZ) || die 'Invalid restored timestamp'
printf 'Restored table: %s\nRestore ID: %s\nRestore point: %s\n' "$target" "$restore_id" "$actual_point"
printf 'Keep both sending switches disabled. Invoke restore-apply with selected types, then restore-check using this restore_point. Review restore-reports/%s.json before enabling sending.\n' "$restore_id"
