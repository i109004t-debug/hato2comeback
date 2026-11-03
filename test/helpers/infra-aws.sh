#!/usr/bin/env bash
set -euo pipefail
# テスト専用。実際のaws実行ファイルへフォールバックしない。
date() {
  if [[ ${MOCK_EPOCH:-} != '' && $* == '-u +%s' ]]; then printf '%s\n' "$MOCK_EPOCH"; else command date "$@"; fi
}
mock_aws() {
  printf '%s\n' "$*" >> "$MOCK_CALLS"
  local args="$*"
  case "$1 $2" in
    'sts get-caller-identity') printf '%s\n' "${MOCK_ACCOUNT:-111111111111}" ;;
    'cloudformation package'|'s3 cp') ;;
    'cloudformation create-change-set'|'cloudformation execute-change-set'|'cloudformation wait') ;;
    'cloudformation get-template')
      printf 'Conditions:\n  HasTopic2: example\nResources:\n  ContactList:\n    Type: AWS::SES::ContactList\n    Properties:\n      Topics:\n'
      if [[ $args == *--change-set-name* && ${MOCK_DECLARATION_CHANGE:-0} == 1 ]]; then printf '        - removed: true\n'; fi
      printf '  OtherResource:\n    Type: example\n'
      ;;
    'cloudformation list-stacks') printf '%s\n' "${MOCK_STATUS:-UPDATE_COMPLETE}" ;;
    'cloudformation list-stack-resources') printf 'ht2-dev-api\tht2-dev-worker\tht2-dev-audit\n' ;;
    'cloudformation describe-stacks')
      case "$args" in
        *StackStatus*) printf '%s\n' "${MOCK_STATUS:-UPDATE_COMPLETE}" ;;
        *"OutputKey=='Environment'"*) printf 'dev\n' ;;
        *"OutputKey=='AccountId'"*) printf '111111111111\n' ;;
        *"OutputKey=='CertificateArn'"*) printf 'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000\n' ;;
        *"OutputKey=='WebAclArn'"*) printf 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/ht2-dev/00000000-0000-0000-0000-000000000000\n' ;;
        *"OutputKey=='WebBucketName'"*) printf 'example-web\n' ;;
        *"OutputKey=='DistributionId'"*) printf 'EXAMPLEDIST\n' ;;
        *"OutputKey=='AuthDomain'"*) printf 'https://ht2-example-dev.auth.ap-northeast-1.amazoncognito.com\n' ;;
        *"OutputKey=='WebClientId'"*) printf 'exampleclient123\n' ;;
        *"OutputKey=='UserPoolId'"*) printf 'ap-northeast-1_example\n' ;;
        *"OutputKey=='RedirectUri'"*) printf 'https://app.dev.example.jp/callback.html\n' ;;
        *"OutputKey=='LogoutUri'"*) printf 'https://app.dev.example.jp/\n' ;;
        *"OutputKey=='ApiBaseUrl'"*) printf '/api/v1\n' ;;
        *"OutputKey=='SenderDomainName'"*) printf 'fc.dev.example.jp\n' ;;
        *"OutputKey=='DataBucketName'"*) printf 'example-data\n' ;;
        *"OutputKey=='TableName'"*) printf 'ht2-dev\n' ;;
        *"OutputKey=='ContactListName'"*) printf 'ht2\n' ;;
        *"OutputKey=='WorkerFunctionName'"*) printf 'ht2-dev-worker\n' ;;
        *"OutputKey=='StateMachineArn'"*) printf 'arn:aws:states:ap-northeast-1:111111111111:stateMachine:ht2-dev\n' ;;
        *"OutputKey=='ConfigurationSetName'"*) printf 'ht2-dev\n' ;;
        *) printf 'unexpected mock query: %s\n' "$args" >&2; return 99 ;;
      esac ;;
    'cloudformation describe-change-set')
      case "$args" in
        *"ResourceChange.LogicalResourceId=='ContactList'"*) printf '%s\n' "${MOCK_CONTACT_CHANGE:-Modify False}" ;;
        *'starts_with(ParameterKey'*) [[ ${MOCK_QUERY_FAIL:-0} == 0 ]] || return 99; printf '%s\n' "${MOCK_TOPICS:-kaiho event}" ;;
        *) printf 'reviewed\n' ;;
      esac ;;
    'sesv2 get-contact-list') printf 'kaiho\tevent\n' ;;
    'sesv2 get-configuration-set') printf '%s\n' "${MOCK_SET_SENDING:-False}" ;;
    'stepfunctions list-executions')
      [[ ${MOCK_EXECUTIONS_ERROR:-0} == 0 ]] || return 254
      if [[ $args == *'length(executions)'* ]]; then printf '%s\n' "${MOCK_RUNNING_LEFT:-0}"; else printf '%s\n' "${MOCK_RUNNING_ARNS:-}"; fi ;;
    'stepfunctions stop-execution') [[ ${MOCK_STOP_ERROR:-0} == 0 ]] || return 254 ;;
    'dynamodb restore-table-to-point-in-time') [[ ${MOCK_RESTORE_ERROR:-0} == 0 ]] || return 254; printf '{}\n' ;;
    'dynamodb wait') [[ ${MOCK_RESTORE_WAIT_ERROR:-0} == 0 ]] || return 254 ;;
    'dynamodb describe-table') printf '2026-11-03T09:00:00.000Z\n' ;;
    'sesv2 get-account') [[ ${MOCK_ACCOUNT_ERROR:-0} == 0 ]] || return 254; printf '%s\n' "${MOCK_PRODUCTION:-True}" ;;
    'lambda invoke')
      local sdk_result=${MOCK_SDK_RESULT:-}
      if [[ -z $sdk_result ]]; then sdk_result='{"ok":true,"packages":[]}'; fi
      printf '%s\n' "$sdk_result" > "${@: -1}"
      printf '%s\n' "${MOCK_FUNCTION_ERROR:-None}" ;;
    'cloudfront get-distribution'|'stepfunctions describe-state-machine'|'sesv2 get-configuration-set-event-destinations'|'cloudwatch describe-alarms') printf '{}\n' ;;
    'ssm get-parameter')
      case "${MOCK_CONFIG:-exists}" in
        missing) printf 'An error occurred (ParameterNotFound) when calling GetParameter\n' >&2; return 254 ;;
        denied) printf 'An error occurred (AccessDeniedException)\n' >&2; return 254 ;;
        network) printf 'Could not connect\n' >&2; return 255 ;;
      esac
      printf '{"sending_enabled":%s}\n' "${MOCK_SENDING:-false}" ;;
    'ssm put-parameter') [[ ${MOCK_CONFIG_RACE:-0} == 0 ]] || return 254 ;;
    'cloudfront create-invalidation') printf 'EXAMPLEINVALIDATION\n' ;;
    'cloudfront wait') ;;
    'lambda get-function-concurrency') printf '%s\n' "${MOCK_CONCURRENCY:-0}" ;;
    'lambda get-function-configuration') printf '%s\n' "${MOCK_RUNTIME_ARN:-arn:aws:lambda:ap-northeast-1::runtime:abcdef}" ;;
    'lambda put-function-concurrency'|'lambda delete-function-concurrency') ;;
    'dynamodb get-item') printf '%s\n' "${MOCK_OWNER:-restore:dev}" ;;
    'dynamodb update-item') ;;
    'dynamodb query')
      [[ ${MOCK_CAMPAIGN_ERROR:-0} == 0 ]] || return 254
      if [[ $args == *--projection-expression* ]]; then printf '%s' "${MOCK_CAMPAIGNS:-}"; else printf '{"Items":[]}\n'; fi ;;
    'sesv2 list-contacts') printf '{"Contacts":[]}\n' ;;
    's3api head-object')
      if [[ $args == *.manifest.json* && ${MOCK_MANIFEST_ERROR:-} != '' ]]; then
        printf 'An error occurred (%s) when calling HeadObject\n' "$MOCK_MANIFEST_ERROR" >&2
        return 254
      fi
      printf '123\n' ;;
    'sesv2 create-import-job') printf '{"JobId":"example-job"}\n' ;;
    'sesv2 get-import-job') printf '%s\n' "${MOCK_JOB_STATUS:-COMPLETED}" ;;
    'sesv2 get-contact')
      [[ ${MOCK_CONTACT_ERROR:-0} == 0 ]] || return 254
      if [[ ${MOCK_CONTACT_NO_ATTR:-0} == 1 ]]; then
        printf '{"ContactListName":"ht2","EmailAddress":"member@example.jp","TopicPreferences":[]}\n'
      else
        printf '%s\n' '{"ContactListName":"ht2","EmailAddress":"member@example.jp","TopicPreferences":[{"TopicName":"kaiho","SubscriptionStatus":"OPT_OUT"},{"TopicName":"event","SubscriptionStatus":"OPT_IN"}],"AttributesData":"{\"name\":\"会員\",\"consent\":{\"source\":\"入会\"}}"}'
      fi ;;
    'sesv2 update-contact') ;;
    'cognito-idp admin-create-user') printf '%s\n' "${MOCK_STAFF_USERNAME:-staff-uuid}" ;;
    'cognito-idp admin-add-user-to-group'|'cognito-idp admin-set-user-mfa-preference'|'cognito-idp admin-user-global-sign-out'|'cognito-idp admin-enable-user') [[ ${MOCK_STAFF_ERROR:-0} == 0 ]] || return 254 ;;
    *) printf 'Unexpected mock AWS call: %s\n' "$args" >&2; return 99 ;;
  esac
}
aws() {
  [[ ${AWS_CLI_FILE_ENCODING:-} == UTF-8 ]] || { printf 'UTF-8 setting missing\n' >&2; return 99; }
  local value line
  value=$(mock_aws "$@") || return $?
  if [[ ${MOCK_CRLF:-0} == 1 ]]; then
    while IFS= read -r line; do printf '%s\r\n' "$line"; done <<< "$value"
  else
    printf '%s\n' "$value"
  fi
}
