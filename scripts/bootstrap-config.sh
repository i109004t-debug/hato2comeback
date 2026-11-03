#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/bootstrap-config.sh ENV}"
mkdir -p build
ERROR_FILE="build/$ENV.config-read-error.txt"
# ParameterNotFoundだけを初回と扱う。権限不足・通信障害では作成へ進まない。
if aws_text ssm get-parameter --region "$REGION" --name "/ht2/$ENV/config" --query Parameter.Version --output text > /dev/null 2> "$ERROR_FILE"; then
  printf 'Config exists; left unchanged.\n'
else
  error=$(< "$ERROR_FILE")
  [[ $error == *'(ParameterNotFound)'* ]] || die 'Cannot determine config existence; stopped'
  IsProduction=false; [[ $ENV != prod ]] || IsProduction=true
  CONFIG="build/$ENV.config.initial.json"
  cat > "$CONFIG" <<EOF
{"sending_enabled":false,"max_rate_per_sec":10,"ses_rate_safety_factor":0.8,"batch_size":200,"progress_every":20,"max_recipients_per_campaign":100000,"lock_ttl_seconds":7200,"pause_timeout_days":7,"reputation_alarms":["ht2-${ENV}-ses-bounce-rate","ht2-${ENV}-ses-complaint-rate"],"campaign_bounce_pause_ratio":0.05,"campaign_min_sample":200,"campaign_delay_pause_ratio":0.10,"daily_send_cap":1000,"delivery_check_required":${IsProduction},"nonprod_allowlist":[],"nonprod_allowlist_s3_key":"","health_check_seconds":60,"auth_status_max_age_hours":26,"delivery_check_max_age_days":90,"max_pending_days":7,"event_log_stale_seconds":900}
EOF
  # --overwriteは付けない。存在確認後に別担当者が作った場合も上書きしない。
  aws ssm put-parameter --region "$REGION" --name "/ht2/$ENV/config" --type String --value "file://$CONFIG"
  printf 'Created config with sending disabled.\n'
fi
