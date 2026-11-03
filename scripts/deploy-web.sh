#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/deploy-web.sh ENV [config-only]}"
check_stack
mkdir -p web
# 値の出所は管理されたスタック出力だけ。秘密・トークンは書かない。
AUTH=$(output AuthDomain); CLIENT=$(output WebClientId); REDIRECT=$(output RedirectUri)
LOGOUT=$(output LogoutUri); API=$(output ApiBaseUrl); POOL=$(output UserPoolId)
DOMAIN=$(output SenderDomainName)
for value in "$AUTH" "$CLIENT" "$REDIRECT" "$LOGOUT" "$API" "$POOL" "$DOMAIN"; do
  [[ $value =~ ^[A-Za-z0-9:/._-]+$ ]] || die 'Unexpected characters in web output'
done
printf '{"env":"%s","region":"%s","authDomain":"%s","clientId":"%s","userPoolId":"%s","redirectUri":"%s","logoutUri":"%s","apiBaseUrl":"%s","senderDomain":"%s"}\n' \
  "$ENV" "$REGION" "$AUTH" "$CLIENT" "$POOL" "$REDIRECT" "$LOGOUT" "$API" "$DOMAIN" > web/config.json
[[ ${2:-} != config-only ]] || exit 0
[[ -f web/index.html && -f web/callback.html ]] || die 'Web application is not present; generated config.json only'
BUCKET=$(output WebBucketName); DIST=$(output DistributionId)
for spec in 'html:text/html' 'js:application/javascript' 'css:text/css' 'json:application/json'; do
  extension=${spec%%:*}; content_type=${spec#*:}
  aws s3 cp web/ "s3://$BUCKET/" --recursive --region "$REGION" --exclude '*' --include "*.$extension" \
    --content-type "$content_type; charset=utf-8" --cache-control 'no-cache,max-age=0,must-revalidate'
done
INVALIDATION=$(aws_text cloudfront create-invalidation --region "$REGION" --distribution-id "$DIST" --paths '/*' --query Invalidation.Id --output text)
[[ -n $INVALIDATION && $INVALIDATION != None ]] || die 'Missing invalidation ID'
aws cloudfront wait invalidation-completed --region "$REGION" --distribution-id "$DIST" --id "$INVALIDATION"
