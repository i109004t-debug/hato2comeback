#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/staff.sh ENV create-admin EMAIL NAME | reset-mfa USERNAME | enable USERNAME}"
check_stack
pool=$(output UserPoolId)
action=${2:?action required}
case "$action" in
  create-admin)
    email=${3:?email required}
    name=${4:?name required}
    [[ $email =~ ^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+$ && -n $name && $name != *$'\r'* && $name != *$'\n'* && $name != *'"'* && $name != *'\'* ]] || die 'Invalid email/name'
    wait_input "Confirm the person's email address before creating an administrator in $ENV. Type: create-admin $HT2_ACCOUNT_ID" "create-admin $HT2_ACCOUNT_ID"
    username=$(aws_text cognito-idp admin-create-user --region "$REGION" --user-pool-id "$pool" --username "$email" \
      --user-attributes "Name=email,Value=\"$email\"" 'Name=email_verified,Value=true' "Name=name,Value=\"$name\"" --desired-delivery-mediums EMAIL \
      --query User.Username --output text)
    [[ $username =~ ^[A-Za-z0-9_-]+$ ]] || die 'Unsafe username returned; inspect Cognito before retrying'
    aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$pool" --username "$username" --group-name admin
    ;;
  reset-mfa|enable)
    username=${3:?username required}
    [[ $username =~ ^[A-Za-z0-9_-]+$ ]] || die 'Use the Cognito Username, not an email address'
    wait_input "Apply $action to $username in $ENV? Type: $action $HT2_ACCOUNT_ID $username" "$action $HT2_ACCOUNT_ID $username"
    if [[ $action == reset-mfa ]]; then
      aws cognito-idp admin-set-user-mfa-preference --region "$REGION" --user-pool-id "$pool" --username "$username" --software-token-mfa-settings Enabled=false,PreferredMfa=false
      aws cognito-idp admin-user-global-sign-out --region "$REGION" --user-pool-id "$pool" --username "$username"
    else
      aws cognito-idp admin-enable-user --region "$REGION" --user-pool-id "$pool" --username "$username"
    fi
    ;;
  *) die 'action must be create-admin, reset-mfa or enable' ;;
esac
