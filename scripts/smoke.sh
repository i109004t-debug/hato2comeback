#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
init_env "${1:?Usage: bash scripts/smoke.sh ENV}"
check_stack
mkdir -p build
SDK_FILE="build/$ENV.sdk-check.json"
SDK_RESULT_FILE="build/$ENV.sdk-check.result.json"
SDK_NEXT="build/$ENV.sdk-check.next.json"
trap 'rm -f -- "$SDK_RESULT_FILE" "$SDK_NEXT"' EXIT
SDK_ERROR=$(aws_text lambda invoke --region "$REGION" --function-name "$(output WorkerFunctionName)" \
  --invocation-type RequestResponse --cli-binary-format raw-in-base64-out --payload '{"mode":"sdk-check"}' \
  --query FunctionError --output text "$SDK_RESULT_FILE")
[[ $SDK_ERROR == None ]] || die 'SDK check invocation failed'
SDK_RESULT=$(< "$SDK_RESULT_FILE")
[[ ${SDK_RESULT//[[:space:]]/} == '{"ok":true,"packages":['*']}' ]] || die 'One or more runtime SDK packages could not be loaded; inspect the sdk-check result'
FUNCTIONS=$(aws_text cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
  --query "sort(StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId)" --output text)
[[ -n $FUNCTIONS && $FUNCTIONS != None ]] || die 'Runtime versions could not be listed'
printf '{"runtime_versions":{' > "$SDK_NEXT"
separator=''
for function in $FUNCTIONS; do
  [[ $function =~ ^ht2-$ENV-[A-Za-z0-9_-]+$ ]] || die 'Invalid function name'
  runtime=$(aws_text lambda get-function-configuration --region "$REGION" --function-name "$function" \
    --query RuntimeVersionConfig.RuntimeVersionArn --output text)
  [[ $runtime =~ ^arn:aws:lambda:[a-z0-9-]+::runtime:[a-f0-9]+$ ]] || die "Runtime version unavailable: $function"
  printf '%s"%s":"%s"' "$separator" "$function" "$runtime" >> "$SDK_NEXT"
  separator=','
done
printf '},"sdk_check":%s}\n' "$SDK_RESULT" >> "$SDK_NEXT"
if [[ -f $SDK_FILE ]] && ! cmp -s -- "$SDK_FILE" "$SDK_NEXT"; then
  printf 'Runtime/SDK versions changed: %s\n' "$SDK_FILE"
  diff -u -- "$SDK_FILE" "$SDK_NEXT" || [[ $? == 1 ]]
fi
mv -f -- "$SDK_NEXT" "$SDK_FILE"
DIST=$(output DistributionId); WEB=$(output WebBucketName)
aws cloudfront get-distribution --region "$REGION" --id "$DIST" --query 'Distribution.Status' --output text
aws s3api head-object --region "$REGION" --bucket "$WEB" --key config.json --query '{ContentType:ContentType,CacheControl:CacheControl}'
aws s3api head-object --region "$REGION" --bucket "$WEB" --key index.html --query ContentLength
aws stepfunctions describe-state-machine --region "$REGION" --state-machine-arn "$(output StateMachineArn)" --query '{Status:status,Type:type}'
aws sesv2 get-configuration-set-event-destinations --region "$REGION" --configuration-set-name "$(output ConfigurationSetName)" --query 'EventDestinations[].{Name:Name,Enabled:Enabled,Events:MatchingEventTypes}'
sleep 1.1
aws sesv2 get-contact-list --region "$REGION" --contact-list-name "$(output ContactListName)" --query 'Topics[].{Name:TopicName,Default:DefaultSubscriptionStatus}'
aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix "ht2-$ENV-" --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}'
printf 'Read-only service checks completed. Browser HTTPS/login, unauthenticated/direct-origin rejection and real delivery must be checked separately (T-25..T-51).\n'
