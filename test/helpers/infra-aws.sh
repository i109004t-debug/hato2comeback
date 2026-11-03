#!/usr/bin/env bash
set -euo pipefail
# テスト専用。実際のaws実行ファイルへフォールバックしない。
aws() {
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
    'cloudformation describe-stacks')
      case "$args" in
        *StackStatus*) printf '%s\n' "${MOCK_STATUS:-UPDATE_COMPLETE}" ;;
        *"OutputKey=='Environment'"*) printf 'dev\n' ;;
        *"OutputKey=='AccountId'"*) printf '111111111111\n' ;;
        *"OutputKey=='AuthDomain'"*) printf 'https://postline-example-dev.auth.ap-northeast-1.amazoncognito.com\n' ;;
        *"OutputKey=='WebClientId'"*) printf 'exampleclient123\n' ;;
        *"OutputKey=='UserPoolId'"*) printf 'ap-northeast-1_example\n' ;;
        *"OutputKey=='RedirectUri'"*) printf 'https://app.dev.example.jp/callback.html\n' ;;
        *"OutputKey=='LogoutUri'"*) printf 'https://app.dev.example.jp/\n' ;;
        *"OutputKey=='ApiBaseUrl'"*) printf '/api/v1\n' ;;
        *"OutputKey=='DataBucketName'"*) printf 'example-data\n' ;;
        *"OutputKey=='ContactListName'"*) printf 'postline\n' ;;
        *) printf 'unexpected mock query: %s\n' "$args" >&2; return 99 ;;
      esac ;;
    'cloudformation describe-change-set')
      case "$args" in
        *"ResourceChange.LogicalResourceId=='ContactList'"*) printf '%s\n' "${MOCK_CONTACT_CHANGE:-Modify False}" ;;
        *'starts_with(ParameterKey'*) [[ ${MOCK_QUERY_FAIL:-0} == 0 ]] || return 99; printf '%s\n' "${MOCK_TOPICS:-kaiho event}" ;;
        *) printf 'reviewed\n' ;;
      esac ;;
    'sesv2 get-contact-list') printf 'kaiho\tevent\n' ;;
    'ssm get-parameter') printf '{"sending_enabled":%s}\n' "${MOCK_SENDING:-false}" ;;
    'lambda get-function-concurrency') printf '%s\n' "${MOCK_CONCURRENCY:-0}" ;;
    'lambda put-function-concurrency'|'lambda delete-function-concurrency') ;;
    'dynamodb get-item') printf '%s\n' "${MOCK_OWNER:-restore:dev}" ;;
    'dynamodb update-item') ;;
    's3api head-object') printf '123\n' ;;
    'sesv2 create-import-job') printf '{"JobId":"example-job"}\n' ;;
    'sesv2 get-import-job') printf '%s\n' "${MOCK_JOB_STATUS:-COMPLETED}" ;;
    'sesv2 get-contact') printf 'False\n' ;;
    'sesv2 update-contact') ;;
    *) printf 'Unexpected mock AWS call: %s\n' "$args" >&2; return 99 ;;
  esac
}
