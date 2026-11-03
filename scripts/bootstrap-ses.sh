#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/bootstrap-ses.sh ENV [request-production details.json]}"
aws sesv2 put-account-suppression-attributes --region "$REGION" --suppressed-reasons BOUNCE COMPLAINT
if [[ ${2:-} == request-production ]]; then
  [[ -f ${3:-} ]] || die 'Reviewed PutAccountDetails JSON is required'
  wait_input "Submit SES production request for $ENV? Type: request $POSTLINE_ACCOUNT_ID" "request $POSTLINE_ACCOUNT_ID"
  aws sesv2 put-account-details --region "$REGION" --cli-input-json "file://$3"
elif [[ -n ${2:-} ]]; then die 'Unknown action'; fi
aws sesv2 get-account --region "$REGION" \
  --query '{ProductionAccessEnabled:ProductionAccessEnabled,SendingEnabled:SendingEnabled,EnforcementStatus:EnforcementStatus,SendQuota:SendQuota,SuppressionAttributes:SuppressionAttributes}' --output json
