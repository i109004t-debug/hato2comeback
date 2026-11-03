#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/deploy-edge.sh ENV prepare|execute [change-set-name]}"
REGION=us-east-1
STACK="postline-edge-$ENV"
ACTION=${2:-prepare}
PARAMS=${POSTLINE_EDGE_PARAMS:-build/$ENV.edge.params.json}
CHANGE_SET=${3:-postline-edge-$ENV-$EPOCHSECONDS}
[[ $CHANGE_SET =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] || die 'Invalid change set name'
case "$ACTION" in
  prepare)
    [[ -f $PARAMS ]] || die "Create $PARAMS from infra/params/$ENV.edge.json and review its values"
    status=$(aws_text cloudformation list-stacks --region "$REGION" \
      --query "StackSummaries[?StackName=='$STACK' && StackStatus!='DELETE_COMPLETE'].StackStatus | [0]" --output text)
    TYPE=$(stack_type "$status")
    aws cloudformation create-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --change-set-type "$TYPE" --template-body file://infra/edge.yaml --parameters "file://$PARAMS"
    aws cloudformation wait change-set-create-complete --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" --output table
    printf 'Stopped for review. Execute with: bash scripts/deploy-edge.sh %s execute %s\n' "$ENV" "$CHANGE_SET"
    ;;
  execute)
    [[ -n ${3:-} ]] || die 'An explicit reviewed change set name is required'
    status=$(aws_text cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
    TYPE=$(stack_type "$status")
    wait_input "Reviewed certificate, WAF, domain and zone? Type: execute $STACK $CHANGE_SET" "execute $STACK $CHANGE_SET"
    aws cloudformation execute-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    if [[ $TYPE == CREATE ]]; then waiter=stack-create-complete; else waiter=stack-update-complete; fi
    aws cloudformation wait "$waiter" --region "$REGION" --stack-name "$STACK"
    # 主スタックのprepareが、同じ環境の出力を取得してパラメータへ渡す。
    printf 'Edge ready. Next: bootstrap-config.sh, package.sh, deploy.sh prepare.\n'
    ;;
  *) die 'Action must be prepare or execute' ;;
esac
