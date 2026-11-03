#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/deploy-web.sh ENV [config-only]}"
check_stack
mkdir -p web
# 値の出所は管理されたスタック出力だけ。秘密・トークンは書かない。
AUTH=$(output AuthDomain); CLIENT=$(output WebClientId); REDIRECT=$(output RedirectUri)
LOGOUT=$(output LogoutUri); API=$(output ApiBaseUrl); POOL=$(output UserPoolId)
for value in "$AUTH" "$CLIENT" "$REDIRECT" "$LOGOUT" "$API" "$POOL"; do
  [[ $value =~ ^[A-Za-z0-9:/._-]+$ ]] || die 'Unexpected characters in web output'
done
printf '{"env":"%s","region":"%s","authDomain":"%s","clientId":"%s","userPoolId":"%s","redirectUri":"%s","logoutUri":"%s","apiBaseUrl":"%s"}\n' \
  "$ENV" "$REGION" "$AUTH" "$CLIENT" "$POOL" "$REDIRECT" "$LOGOUT" "$API" > web/config.json
[[ ${2:-} != config-only ]] || exit 0
[[ -f web/index.html && -f web/callback.html ]] || die 'Web application is not present; generated config.json only'
BUCKET=$(output WebBucketName); DIST=$(output DistributionId)
aws s3 sync web/ "s3://$BUCKET/" --region "$REGION" --exclude config.json --exclude '*.map' --cache-control 'public,max-age=300'
aws s3 cp web/config.json "s3://$BUCKET/config.json" --region "$REGION" --content-type application/json --cache-control 'no-cache,no-store,must-revalidate'
aws cloudfront create-invalidation --region "$REGION" --distribution-id "$DIST" --paths '/*'
aws cloudfront wait distribution-deployed --region "$REGION" --id "$DIST"
