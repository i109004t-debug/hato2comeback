#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/deploy.sh ENV prepare|execute [change-set-name]}"
ACTION=${2:-prepare}
PARAMS=${POSTLINE_PARAMS:-infra/params/$ENV.json}
CHANGE_SET=${3:-postline-$ENV-$EPOCHSECONDS}
[[ $CHANGE_SET =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] || die 'Invalid change set name'
review_topics() {
  local mode=$1 name old names=() changes
  # パラメータから消えたトピックと、リソース全体の削除・置換を検知する。
  changes=$(aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
    --query "Changes[?ResourceChange.LogicalResourceId=='ContactList'].ResourceChange.[Action,Replacement]" --output text)
  [[ $changes != *Remove* && $changes != *True* && $changes != *Conditional* ]] || die 'WARNING: ContactList deletion/replacement; do not execute'
  if [[ $mode == UPDATE ]]; then
    # Topics要素や条件自体の削除を、パラメータ比較だけで見逃さない。
    # packageが出すYAMLの既存・提案ブロックを比較し、形式不明でも停止する。
    local before after old_block new_block old_conditions new_conditions
    before=$(aws cloudformation get-template --region "$REGION" --stack-name "$STACK" --template-stage Original --query TemplateBody --output text)
    after=$(aws cloudformation get-template --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" --template-stage Original --query TemplateBody --output text)
    old_block=$(declaration "$before" ContactList)
    new_block=$(declaration "$after" ContactList)
    old_conditions=$(declaration "$before" Conditions)
    new_conditions=$(declaration "$after" Conditions)
    [[ -n $old_block && -n $new_block && -n $old_conditions && -n $new_conditions ]] || die 'WARNING: Cannot verify Topics declarations; stopped'
    [[ $old_block == "$new_block" && $old_conditions == "$new_conditions" ]] || die 'WARNING: Topics/conditions declaration changed; potential subscription deletion, stopped'
    mapfile -t names < <(aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --query "Parameters[?starts_with(ParameterKey, 'Topic') && ends_with(ParameterKey, 'Name')].ParameterValue" --output text)
    # --output textはタブ区切り。配列へ明示的に分解する。
    local joined=" ${names[*]} " old_topics
    joined=${joined//$'\t'/ }
    old_topics=$(aws sesv2 get-contact-list --region "$REGION" --contact-list-name postline --query 'Topics[].TopicName' --output text)
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
    [[ -f build/backend.zip ]] || die 'Run package.sh first'
    mkdir -p build
    aws cloudformation package --region "$REGION" --template-file infra/template.yaml --s3-bucket "$ARTIFACT_BUCKET" \
      --s3-prefix "postline/$ENV" --output-template-file build/template.out.yaml
    aws s3 cp build/template.out.yaml "s3://$ARTIFACT_BUCKET/postline/$ENV/$CHANGE_SET.yaml" --region "$REGION"
    # 通信エラーを新規スタックと誤認しない。
    status=$(aws cloudformation list-stacks --region "$REGION" \
      --query "StackSummaries[?StackName=='$STACK' && StackStatus!='DELETE_COMPLETE'].StackStatus | [0]" --output text)
    TYPE=UPDATE; [[ $status != None ]] || TYPE=CREATE
    aws cloudformation create-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --change-set-type "$TYPE" --template-url "https://$ARTIFACT_BUCKET.s3.$REGION.amazonaws.com/postline/$ENV/$CHANGE_SET.yaml" \
      --parameters "file://$PARAMS" --capabilities CAPABILITY_NAMED_IAM
    aws cloudformation wait change-set-create-complete --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    review_topics "$TYPE"
    aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --query 'Changes[].ResourceChange' --output table
    printf 'Stopped for review. Execute with: bash scripts/deploy.sh %s execute %s\n' "$ENV" "$CHANGE_SET"
    ;;
  execute)
    [[ -n ${3:-} ]] || die 'An explicit reviewed change set name is required'
    status=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
    TYPE=UPDATE; [[ $status != REVIEW_IN_PROGRESS ]] || TYPE=CREATE
    review_topics "$TYPE"
    wait_input "Reviewed all changes including Topics? Type: execute $STACK $CHANGE_SET" "execute $STACK $CHANGE_SET"
    aws cloudformation execute-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"
    if [[ $TYPE == CREATE ]]; then waiter=stack-create-complete; else waiter=stack-update-complete; fi
    aws cloudformation wait "$waiter" --region "$REGION" --stack-name "$STACK"
    ;;
  *) die 'Action must be prepare or execute' ;;
esac
