#!/usr/bin/env bash
set -euo pipefail
umask 077
export AWS_PAGER="" AWS_MAX_ATTEMPTS=1 AWS_CLI_FILE_ENCODING=UTF-8
export LC_ALL=C
ROOT=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)
cd -- "$ROOT"
REGION=ap-northeast-1
die() { printf '%s\n' "$*" >&2; exit 1; }
aws_text() {
  local value
  value=$(aws "$@") || return $?
  printf '%s\n' "${value//$'\r'/}"
}
stack_type() {
  case "$1" in
    None|REVIEW_IN_PROGRESS) printf CREATE ;;
    ROLLBACK_COMPLETE) die "Stack $STACK is ROLLBACK_COMPLETE. Inspect retained resources, delete the failed stack explicitly, then prepare again." ;;
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) printf UPDATE ;;
    *) die "Stack $STACK is not ready: $1" ;;
  esac
}
init_env() {
  ENV=${1:?environment required}
  case "$ENV" in dev|stg|prod) ;; *) die 'env must be dev, stg or prod' ;; esac
  : "${POSTLINE_ACCOUNT_ID:?Set the dedicated environment account ID}"
  [[ $POSTLINE_ACCOUNT_ID =~ ^[0-9]{12}$ ]] || die 'Invalid account ID'
  local actual
  actual=$(aws_text sts get-caller-identity --query Account --output text --region "$REGION")
  [[ $actual == "$POSTLINE_ACCOUNT_ID" ]] || die 'Wrong AWS account'
  STACK="postline-main-$ENV"
}
output() {
  local value
  value=$(aws_text cloudformation describe-stacks --region "${3:-$REGION}" --stack-name "${2:-$STACK}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text)
  [[ -n $value && $value != None ]] || die "Missing stack output: $1"
  printf '%s' "$value"
}
check_stack() {
  [[ $(output Environment) == "$ENV" && $(output AccountId) == "$POSTLINE_ACCOUNT_ID" ]] || die 'Stack environment/account mismatch'
}
require_stopped() {
  local enabled
  enabled=$(aws_text ssm get-parameter --region "$REGION" --name "/postline/$ENV/config" \
    --query Parameter.Value --output text)
  [[ $enabled =~ \"sending_enabled\"[[:space:]]*:[[:space:]]*false ]] || die 'sending_enabled must explicitly be false'
}
wait_input() {
  local answer
  printf '%s\n' "$1" >&2
  read -r answer
  [[ $answer == "$2" ]] || die 'Confirmation did not match; stopped'
}
