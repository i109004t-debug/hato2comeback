#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/smoke.sh ENV}"
check_stack
DIST=$(output DistributionId); WEB=$(output WebBucketName)
aws cloudfront get-distribution --region "$REGION" --id "$DIST" --query 'Distribution.Status' --output text
aws s3api head-object --region "$REGION" --bucket "$WEB" --key config.json --query '{ContentType:ContentType,CacheControl:CacheControl}'
aws s3api head-object --region "$REGION" --bucket "$WEB" --key index.html --query ContentLength
aws stepfunctions describe-state-machine --region "$REGION" --state-machine-arn "$(output StateMachineArn)" --query '{Status:status,Type:type}'
aws sesv2 get-configuration-set-event-destinations --region "$REGION" --configuration-set-name "$(output ConfigurationSetName)" --query 'EventDestinations[].{Name:Name,Enabled:Enabled,Events:MatchingEventTypes}'
sleep 1.1
aws sesv2 get-contact-list --region "$REGION" --contact-list-name "$(output ContactListName)" --query 'Topics[].{Name:TopicName,Default:DefaultSubscriptionStatus}'
aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix "postline-$ENV-" --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}'
printf 'Read-only service checks completed. Browser HTTPS/login, unauthenticated/direct-origin rejection and real delivery must be checked separately (T-25..T-51).\n'
