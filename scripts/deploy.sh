#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/deploy.sh ENV prepare|execute [change-set-name] [--refresh-runtime]}"
ACTION=${2:-prepare}
PARAMS=${HT2_PARAMS:-build/$ENV.params.json}
[[ -f $PARAMS ]] || die "Create $PARAMS from infra/params/$ENV.json and review its values"
CHANGE_SET=''
REFRESH_RUNTIME=false
for arg in "${@:3}"; do
  case "$arg" in
    --refresh-runtime) REFRESH_RUNTIME=true ;;
    --*) die "Unknown option: $arg" ;;
    *) [[ -z $CHANGE_SET ]] || die 'Only one change set name is allowed'; CHANGE_SET=$arg ;;
  esac
done
[[ $ACTION != execute || $REFRESH_RUNTIME == false ]] || die 'Use --refresh-runtime when preparing the change set'
EXPLICIT_CHANGE_SET=$CHANGE_SET
CHANGE_SET=${CHANGE_SET:-ht2-$ENV-$EPOCHSECONDS}
[[ $CHANGE_SET =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] || die 'Invalid change set name'
preflight_deploy() {
  [[ $1 == UPDATE ]] || return 0
  check_stack
  local rows id state scheduled extra epoch now warnings='' blocked=0
  now=$(date -u +%s)
  rows=$(aws_text dynamodb query --region "$REGION" --table-name "$(output TableName)" --consistent-read \
    --key-condition-expression 'PK = :pk' --expression-attribute-values '{":pk":{"S":"CAMPAIGN"}}' \
    --projection-expression 'campaign_id,#state,scheduled_at' --expression-attribute-names '{"#state":"status"}' \
    --query 'Items[].[campaign_id.S,status.S,scheduled_at.S]' --output text) || die 'DEPLOY_BLOCKED: Could not read campaigns'
  while read -r id state scheduled extra; do
    [[ -n $id ]] || continue
    [[ $id =~ ^[0-9A-HJKMNP-TV-Z]{26}$ && -n $state && -z $extra ]] || die 'DEPLOY_BLOCKED: Invalid campaign record'
    case "$state" in
      QUEUED|SENDING) printf 'DEPLOY_BLOCKED %s %s\n' "$id" "$state" >&2; blocked=1 ;;
      SCHEDULED)
        epoch=$(date -u -d "$scheduled" +%s) || die "DEPLOY_BLOCKED $id SCHEDULED: Invalid schedule"
        if (( epoch <= now + 3600 )); then printf 'DEPLOY_BLOCKED %s %s\n' "$id" "$state" >&2; blocked=1; fi ;;
      PAUSED|NEEDS_REVIEW) warnings+="$id $state"$'\n' ;;
    esac
  done <<< "$rows"
  (( blocked == 0 )) || die 'DEPLOY_BLOCKED: Active or imminent campaigns'
  if [[ -n $warnings ]]; then
    printf '%s' "$warnings" >&2
    wait_input "Review stopped campaigns. Type: deploy $STACK stopped" "deploy $STACK stopped"
  fi
}
review_topics() {
  local mode=$1 name old names=() changes
  # パラメータから消えたトピックと、リソース全体の削除・置換を検知する。
  changes=$(aws_text cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
    --query "Changes[?ResourceChange.LogicalResourceId=='ContactList'].ResourceChange.[Action,Replacement]" --output text)
  [[ $changes != *Remove* && $changes != *True* && $changes != *Conditional* ]] || die 'WARNING: ContactList deletion/replacement; do not execute'
  if [[ $mode == UPDATE ]]; then
    # Topics要素や条件自体の削除を、パラメータ比較だけで見逃さない。
    # packageが出すYAMLの既存・提案ブロックを比較し、形式不明でも停止する。
    local before after old_block new_block old_conditions new_conditions
    before=$(aws_text cloudformation get-template --region "$REGION" --stack-name "$STACK" --template-stage Original --query TemplateBody --output text)
    after=$(aws_text cloudformation get-template --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" --template-stage Original --query TemplateBody --output text)
    old_block=$(declaration "$before" ContactList)
    new_block=$(declaration "$after" ContactList)
    old_conditions=$(declaration "$before" Conditions)
    new_conditions=$(declaration "$after" Conditions)
    [[ -n $old_block && -n $new_block && -n $old_conditions && -n $new_conditions ]] || die 'WARNING: Cannot verify Topics declarations; stopped'
    [[ $old_block == "$new_block" && $old_conditions == "$new_conditions" ]] || die 'WARNING: Topics/conditions declaration changed; potential subscription deletion, stopped'
    local proposed
    proposed=$(aws_text cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --query "Parameters[?starts_with(ParameterKey, 'Topic') && ends_with(ParameterKey, 'Name')].ParameterValue" --output text)
    names=("$proposed")
    # --output textはタブ区切り。配列へ明示的に分解する。
    local joined=" ${names[*]} " old_topics
    joined=${joined//$'\t'/ }
    old_topics=$(aws_text sesv2 get-contact-list --region "$REGION" --contact-list-name ht2 --query 'Topics[].TopicName' --output text)
    for old in $old_topics; do
      [[ $joined == *" $old "* ]] || die "WARNING: Topic removal ($old); stopped. Retain does not preserve topic subscriptions."
    done
  fi
}
declaration() {
  local body=$1 key=$2 line active=false
  while IFS= read -r line; do
    if [[ $key == Conditions ]]; then
      if [[ $line == Conditions: ]]; then active=true; fi
      if [[ $active == true && $line =~ ^[A-Za-z][A-Za-z0-9]*: && $line != Conditions: ]]; then break; fi
    else
      if [[ $line == '  ContactList:' ]]; then active=true
      elif [[ $active == true && $line =~ ^\ \ [A-Za-z][A-Za-z0-9]*: ]]; then break; fi
    fi
    if [[ $active == true ]]; then printf '%s\n' "$line"; fi
  done <<< "$body"
}
case "$ACTION" in
  prepare)
    : "${ARTIFACT_BUCKET:?Set the private Tokyo artifact bucket}"
    [[ -f build/backend/package.json && -d build/backend/src ]] || die 'Run package.sh first'
    status=$(aws_text cloudformation list-stacks --region "$REGION" \
      --query "StackSummaries[?StackName=='$STACK' && StackStatus!='DELETE_COMPLETE'].StackStatus | [0]" --output text)
    TYPE=$(stack_type "$status")
    preflight_deploy "$TYPE"
    aws_text ssm get-parameter --region "$REGION" --name "/ht2/$ENV/config" --query Parameter.Version --output text > /dev/null
    [[ $(output Environment "ht2-edge-$ENV" us-east-1) == "$ENV" && $(output AccountId "ht2-edge-$ENV" us-east-1) == "$HT2_ACCOUNT_ID" ]] || die 'Edge stack environment/account mismatch'
    CERT=$(output CertificateArn "ht2-edge-$ENV" us-east-1)
    ACL=$(output WebAclArn "ht2-edge-$ENV" us-east-1)
    [[ $CERT =~ ^arn:aws:acm:us-east-1:$HT2_ACCOUNT_ID:certificate/[a-f0-9-]{36}$ ]] || die 'Invalid edge certificate ARN'
    [[ $ACL =~ ^arn:aws:wafv2:us-east-1:$HT2_ACCOUNT_ID:global/webacl/[A-Za-z0-9_-]+/[a-f0-9-]{36}$ ]] || die 'Invalid edge WAF ARN'
    PARAMETER_TEXT=$(< "$PARAMS")
    [[ $PARAMETER_TEXT == *REPLACE_WITH_EDGE_CERTIFICATE_ARN* && $PARAMETER_TEXT == *REPLACE_WITH_EDGE_WEB_ACL_ARN* ]] || die 'Keep edge ARN placeholders in the main parameters; values come from the edge stack'
    PARAMETER_TEXT=${PARAMETER_TEXT//REPLACE_WITH_EDGE_CERTIFICATE_ARN/$CERT}
    PARAMETER_TEXT=${PARAMETER_TEXT//REPLACE_WITH_EDGE_WEB_ACL_ARN/$ACL}
    mkdir -p build
    PARAMS="build/$ENV.main.resolved.params.json"
    REFRESH_TOKEN=''
    if [[ $REFRESH_RUNTIME == true ]]; then REFRESH_TOKEN=$(date -u +%Y%m%dT%H%M%SZ); fi
    if [[ -n $REFRESH_TOKEN || $TYPE == CREATE ]]; then
      RUNTIME_PARAMETER="{\"ParameterKey\":\"RuntimeRefreshToken\",\"ParameterValue\":\"$REFRESH_TOKEN\"}"
    else
      previous_runtime=$(aws_text cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
        --query "Stacks[0].Parameters[?ParameterKey=='RuntimeRefreshToken'].ParameterKey | [0]" --output text)
      case "$previous_runtime" in
        RuntimeRefreshToken) RUNTIME_PARAMETER='{"ParameterKey":"RuntimeRefreshToken","UsePreviousValue":true}' ;;
        None) RUNTIME_PARAMETER='{"ParameterKey":"RuntimeRefreshToken","ParameterValue":""}' ;;
        *) die 'Cannot verify the previous runtime refresh parameter' ;;
      esac
    fi
    # パラメータは平坦なオブジェクトの配列。更新用の項目だけを置き換える。
    runtime_pattern='\{[^{}]*"ParameterKey"[[:space:]]*:[[:space:]]*"RuntimeRefreshToken"[^{}]*\}'
    if [[ $PARAMETER_TEXT =~ $runtime_pattern ]]; then
      runtime_entry=${BASH_REMATCH[0]}
      PARAMETER_TEXT=${PARAMETER_TEXT/"$runtime_entry"/"$RUNTIME_PARAMETER"}
    else
      [[ $PARAMETER_TEXT == *']'* ]] || die 'Invalid parameters JSON'
      PARAMETER_TEXT="${PARAMETER_TEXT%]*},$RUNTIME_PARAMETER]"
    fi
    printf '%s\n' "$PARAMETER_TEXT" > "$PARAMS"
    aws cloudformation package --region "$REGION" --template-file infra/template.yaml --s3-bucket "$ARTIFACT_BUCKET" \
      --s3-prefix "ht2/$ENV" --output-template-file build/template.out.yaml
    aws s3 cp build/template.out.yaml "s3://$ARTIFACT_BUCKET/ht2/$ENV/$CHANGE_SET.yaml" --region "$REGION"
    aws cloudformation create-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --change-set-type "$TYPE" --template-url "https://$ARTIFACT_BUCKET.s3.$REGION.amazonaws.com/ht2/$ENV/$CHANGE_SET.yaml" \
      --parameters "file://$PARAMS" --capabilities CAPABILITY_NAMED_IAM
    aws cloudformation wait change-set-create-complete --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    review_topics "$TYPE"
    aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --query 'Changes[].ResourceChange' --output table
    printf 'Stopped for review. Execute with: bash scripts/deploy.sh %s execute %s\n' "$ENV" "$CHANGE_SET"
    ;;
  execute)
    [[ -n $EXPLICIT_CHANGE_SET ]] || die 'An explicit reviewed change set name is required'
    status=$(aws_text cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
    TYPE=$(stack_type "$status")
    preflight_deploy "$TYPE"
    review_topics "$TYPE"
    wait_input "Reviewed all changes including Topics? Type: execute $STACK $CHANGE_SET" "execute $STACK $CHANGE_SET"
    aws cloudformation execute-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    if [[ $TYPE == CREATE ]]; then waiter=stack-create-complete; else waiter=stack-update-complete; fi
    aws cloudformation wait "$waiter" --region "$REGION" --stack-name "$STACK"
    ;;
  *) die 'Action must be prepare or execute' ;;
esac
