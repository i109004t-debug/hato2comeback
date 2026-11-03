#!/usr/bin/env bash
# 対話端末でsourceする読取専用ヘルパー。シェルのオプションや作業場所は変えない。
export AWS_PAGER="" AWS_MAX_ATTEMPTS=1 AWS_CLI_FILE_ENCODING=UTF-8
REGION=ap-northeast-1
aws_text() {
  local value
  value=$(aws "$@") || return $?
  printf '%s\n' "${value//$'\r'/}"
}
init_env() {
  local requested=${1:-} actual
  case "$requested" in dev|stg|prod) ;; *) printf 'env must be dev, stg or prod\n' >&2; return 1 ;; esac
  [[ ${HT2_ACCOUNT_ID:-} =~ ^[0-9]{12}$ ]] || { printf 'Set a valid HT2_ACCOUNT_ID\n' >&2; return 1; }
  actual=$(aws_text sts get-caller-identity --query Account --output text --region "$REGION") || return $?
  [[ $actual == "$HT2_ACCOUNT_ID" ]] || { printf 'Wrong AWS account\n' >&2; return 1; }
  ENV=$requested
  STACK="ht2-main-$ENV"
}
output() {
  local name=${1:-} stack=${2:-${STACK:-}} value
  [[ -n $name && -n $stack ]] || { printf 'Output name and stack are required\n' >&2; return 1; }
  value=$(aws_text cloudformation describe-stacks --region "${3:-$REGION}" --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$name'].OutputValue | [0]" --output text) || return $?
  [[ -n $value && $value != None ]] || { printf 'Missing stack output: %s\n' "$name" >&2; return 1; }
  printf '%s' "$value"
}
check_stack() {
  local environment account
  environment=$(output Environment) || return $?
  account=$(output AccountId) || return $?
  [[ $environment == "${ENV:-}" && $account == "${HT2_ACCOUNT_ID:-}" ]] || { printf 'Stack environment/account mismatch\n' >&2; return 1; }
}
