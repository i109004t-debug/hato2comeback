#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
umask 077
init_env "${1:?Usage: bash scripts/restore-contacts.sh ENV freeze|export|import|status|apply-stops|finish [arguments]}"
check_stack
require_stopped
BUCKET=$(output DataBucketName)
LIST=$(output ContactListName)
API_FUNCTION="postline-$ENV-api"
OWNER="restore:$ENV"
LOCK_KEY='{"PK":{"S":"LOCK"},"SK":{"S":"CONTACT_CREATE"}}'
frozen() {
  local concurrency owner
  concurrency=$(aws lambda get-function-concurrency --region "$REGION" --function-name "$API_FUNCTION" --query ReservedConcurrentExecutions --output text)
  [[ $concurrency == 0 ]] || die 'Freeze the management API first (new registrations/imports must be blocked)'
  owner=$(aws dynamodb get-item --region "$REGION" --table-name "postline-$ENV" --consistent-read --key "$LOCK_KEY" --query Item.owner.S --output text)
  [[ $owner == "$OWNER" ]] || die 'Restore must own CONTACT_CREATE; reconcile existing jobs first'
}
case "${2:-}" in
  freeze)
    aws lambda put-function-concurrency --region "$REGION" --function-name "$API_FUNCTION" --reserved-concurrent-executions 0
    aws dynamodb update-item --region "$REGION" --table-name "postline-$ENV" --key "$LOCK_KEY" \
      --update-expression 'SET #owner = :owner, #state = :state' --condition-expression 'attribute_not_exists(#owner) OR #owner = :owner' \
      --expression-attribute-names '{"#owner":"owner","#state":"state"}' \
      --expression-attribute-values "{\":owner\":{\"S\":\"$OWNER\"},\":state\":{\"S\":\"RESTORING\"}}" >/dev/null
    printf 'API frozen. Stop/cancel active campaigns, wait for in-flight API/worker/imports to settle, and disable scheduled starts before proceeding. Do not delete locks by TTL.\n'
    ;;
  export)
    frozen
    DATE=${3:?backup date YYYY-MM-DD}; MONTH=${4:?audit month YYYYMM}
    [[ $DATE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $MONTH =~ ^[0-9]{6}$ ]] || die 'Invalid date/month'
    DIR="build/restore-$ENV-$DATE"; mkdir -p "$DIR"
    aws s3 cp "s3://$BUCKET/backups/contacts/$DATE.jsonl.gz" "$DIR/contacts.jsonl.gz" --region "$REGION"
    aws s3 cp "s3://$BUCKET/imports/ready/" "$DIR/imports/" --recursive --region "$REGION"
    aws dynamodb query --region "$REGION" --table-name "postline-$ENV" --consistent-read \
      --key-condition-expression 'PK = :pk' --expression-attribute-values "{\":pk\":{\"S\":\"AUDIT#$MONTH\"}}" --output json > "$DIR/audit-$MONTH.json"
    aws dynamodb query --region "$REGION" --table-name "postline-$ENV" --consistent-read \
      --key-condition-expression 'PK = :pk' --expression-attribute-values '{":pk":{"S":"ERASED"}}' --output json > "$DIR/erased.json"
    aws sesv2 list-contacts --region "$REGION" --contact-list-name "$LIST" --output json > "$DIR/current-contacts.json"
    printf 'Exported %s. Repeat export for every audit month. Reconcile attributes/HMAC erasures, latest SES stops and deduplicated Subscription transitions with Athena; review the CSV and evidence before import.\n' "$DIR"
    ;;
  import)
    frozen
    CSV=${3:?reviewed SES CSV file}; REVIEW=${4:?review evidence S3 key}
    [[ -f $CSV && $REVIEW == delivery-checks/* ]] || die 'Reviewed CSV and private evidence key required'
    aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$REVIEW" --query ContentLength >/dev/null
    wait_input "Confirm erased HMAC exclusion, attributes, consent, latest SES stops/suppression and stop deltas through now. Type: restore $POSTLINE_ACCOUNT_ID $ENV" "restore $POSTLINE_ACCOUNT_ID $ENV"
    KEY="imports/ready/restore-$EPOCHSECONDS.csv"
    aws s3 cp "$CSV" "s3://$BUCKET/$KEY" --region "$REGION" --content-type 'text/csv; charset=utf-8'
    # 結果不明でも同じジョブを自動作成しない。CloudTrailで照合する。
    aws sesv2 create-import-job --region "$REGION" \
      --import-destination "{\"ContactListDestination\":{\"ContactListName\":\"$LIST\",\"ContactListImportAction\":\"PUT\"}}" \
      --import-data-source "{\"S3Url\":\"s3://$BUCKET/$KEY\",\"DataFormat\":\"CSV\"}" --output json
    printf 'Keep sending and API disabled. Record JobId; use status, then apply-stops for post-import deltas.\n'
    ;;
  status)
    frozen
    aws sesv2 get-import-job --region "$REGION" --job-id "${3:?JobId}" --output json
    ;;
  apply-stops)
    frozen
    MANIFEST=${3:?TSV file: email TAB topic-name or ALL}; JOB=${4:?completed JobId}
    [[ -f $MANIFEST ]] || die 'Stop manifest missing'
    state=$(aws sesv2 get-import-job --region "$REGION" --job-id "$JOB" --query JobStatus --output text)
    [[ $state == COMPLETED ]] || die 'Import must be COMPLETED; check failed-record counts separately'
    # SESには購読状態の条件付き更新がない。競合で他トピックを戻さないよう全停止へ倒す。
    while IFS=$'\t' read -r email topic extra || [[ -n ${email:-} ]]; do
      [[ -n $email && $email != *[[:space:]\"\\]* && -z $extra ]] || die 'Invalid stop manifest'
      [[ $topic == ALL || $topic =~ ^[a-z0-9_]{1,20}$ ]] || die 'Invalid stop topic'
      all=$(aws sesv2 get-contact --region "$REGION" --contact-list-name "$LIST" --email-address "$email" --query UnsubscribeAll --output text)
      [[ $all == True || $all == False ]] || die 'Unknown unsubscribe state'
      [[ $all != True ]] || continue
      sleep 1.1
      aws sesv2 update-contact --region "$REGION" --contact-list-name "$LIST" --email-address "$email" --unsubscribe-all
      sleep 1.1
    done < "$MANIFEST"
    printf 'Re-query delayed events and repeat stop-only reconciliation. Verify counts, attributes and suppression; record administrator approval. Sending/API remain disabled.\n'
    ;;
  finish)
    frozen
    REVIEW=${3:?final evidence key}
    [[ $REVIEW == delivery-checks/* ]] || die 'Private evidence key required'
    aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$REVIEW" --query ContentLength >/dev/null
    wait_input "Confirm import completion, repeated delayed-stop reconciliation, erasure/suppression/attributes checks and administrator record. Keep sending disabled. Type: release $POSTLINE_ACCOUNT_ID $ENV" "release $POSTLINE_ACCOUNT_ID $ENV"
    aws dynamodb update-item --region "$REGION" --table-name "postline-$ENV" --key "$LOCK_KEY" \
      --update-expression 'REMOVE #owner, #state' --condition-expression '#owner = :owner' \
      --expression-attribute-names '{"#owner":"owner","#state":"state"}' \
      --expression-attribute-values "{\":owner\":{\"S\":\"$OWNER\"}}" >/dev/null
    aws lambda delete-function-concurrency --region "$REGION" --function-name "$API_FUNCTION"
    printf 'API released. Sending remains disabled; administrator must revalidate and resume separately.\n'
    ;;
  *) die 'Action must be freeze, export, import, status, apply-stops or finish' ;;
esac
