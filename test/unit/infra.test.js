import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AWS_APIS } from '../../src/common/aws.js';
import { configDefaults, validateConfig } from '../../src/common/config.js';
import { REQUIRED_EVENTS } from '../../src/common/precheck.js';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const main = read('infra/template.yaml');
const edge = read('infra/edge.yaml');
// YAMLは解析せず、トップレベル論理名で各ブロックだけを取り出す。
function blocks(text, section = 'Resources') {
  const body = text.split(`\n${section}:\n`)[1]?.split(/\n[A-Za-z][A-Za-z0-9]*:\n/)[0];
  assert.ok(body, section);
  return Object.fromEntries([...body.matchAll(/^  ([A-Za-z0-9]+):\n([\s\S]*?)(?=^  [A-Za-z0-9]+:\n|$(?![\s\S]))/gm)].map((m) => [m[1], m[2]]));
}
const resources = blocks(main);
const outputs = blocks(main, 'Outputs');
const scripts = readdirSync(new URL('../../scripts/', import.meta.url)).filter((f) => f.endsWith('.sh'));

test('第11段階 8.5 SESの3発行先と既定バスのルール、呼出し元を制約した許可を定義する', () => {
  for (const name of ['CloudWatchDestination', 'FirehoseDestination', 'EventBridgeDestination']) {
    assert.match(resources[name], /Enabled: true/);
    for (const event of REQUIRED_EVENTS) assert.ok(resources[name].includes(event));
  }
  assert.match(resources.EventBridgeDestination, /EventBusArn: !Sub 'arn:\$\{AWS::Partition\}:events:\$\{AWS::Region\}:\$\{AWS::AccountId\}:event-bus\/default'/);
  assert.match(resources.SesEventsRule, /source: \[aws.ses\]/);
  assert.match(resources.SesEventsRule, /'ses:configuration-set': \[!Sub 'ht2-\$\{Env\}'\]/);
  assert.match(resources.SesEventsRule, /Arn: !GetAtt EventsFunction.Arn/);
  for (const text of ['AWS::Lambda::Permission', 'FunctionName: !Ref EventsFunction', 'Principal: events.amazonaws.com', 'SourceArn: !GetAtt SesEventsRule.Arn', "SourceAccount: !Ref 'AWS::AccountId'"]) assert.ok(resources.EventsInvokePermission.includes(text), text);
});

test('第11段階 12.6 EventsFunctionのロールは同じテーブルのADDR#*へのPutItemだけ', () => {
  assert.deepEqual([...allowed(resources.EventsRole)], ['dynamodb:PutItem']);
  assert.match(resources.EventsRole, /Resource: !GetAtt Table.Arn/);
  assert.match(resources.EventsRole, /'ForAllValues:StringLike': \{'dynamodb:LeadingKeys': \['ADDR#\*'\]\}/);
  assert.doesNotMatch(resources.EventsRole, /ManagedPolicyArns|Resource: '\*'|ses:|secretsmanager:|sns:|s3:|dynamodb:(?:GetItem|UpdateItem|Query|DeleteItem)/);
  assert.match(resources.EventsFunction, /Handler: src\/events\/handler.handler/);
  assert.match(resources.EventsFunction, /Role: !GetAtt EventsRole.Arn/);
});

test('第11段階 12.6 Cognito追加権限はユーザープールだけ、証跡の書込と取込の削除は接頭辞だけ', () => {
  const statement = resources.ApiPolicy.split(/\n          - /).find((part) => part.includes('cognito-idp:'));
  const expected = ['AdminGetUser', 'AdminListGroupsForUser', 'ListUsersInGroup', 'AdminCreateUser', 'AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'AdminDisableUser', 'AdminEnableUser', 'AdminUserGlobalSignOut', 'AdminSetUserMFAPreference', 'AdminResetUserPassword'];
  assert.deepEqual([...statement.matchAll(/cognito-idp:([A-Za-z]+)/g)].map((item) => item[1]), expected);
  assert.match(statement, /Resource: !GetAtt UserPool.Arn/);
  assert.doesNotMatch(resources.ApiPolicy, /cognito-idp:(?:AdminDeleteUser|UpdateUserPool|DeleteUserPool|\*)/);
  const put = resources.ApiPolicy.split(/\n          - /).find((part) => part.includes("Action: ['s3:PutObject']"));
  assert.match(put, /Resource: \[!Sub '\$\{DataBucket.Arn\}\/imports\/staging\/\*', !Sub '\$\{DataBucket.Arn\}\/delivery-checks\/\*'\]/);
  const deletion = resources.ApiPolicy.split(/\n          - /).find((part) => part.includes("Action: ['s3:DeleteObject']"));
  assert.match(deletion, /Resource: \[!Sub '\$\{DataBucket.Arn\}\/recipients\/\*', !Sub '\$\{DataBucket.Arn\}\/imports\/staging\/\*'\]/);
  assert.match(resources.DataBucket, /Prefix: imports\/preview\/, ExpirationInDays: 7/);
});

test('第9段階 4.6 監査保管庫はObject Lock・保持・暗号化・公開ブロック・TLSを持つ', () => {
  const parameters = blocks(main, 'Parameters');
  assert.match(parameters.AuditLockMode, /Default: GOVERNANCE\n    AllowedValues: \[GOVERNANCE, COMPLIANCE\]/);
  assert.match(parameters.AuditLockDays, /Default: 400/);
  assert.match(resources.Table, /StreamSpecification: \{StreamViewType: NEW_AND_OLD_IMAGES\}/);
  const bucket = resources.AuditArchiveBucket;
  for (const requirement of ['ObjectLockEnabled: true', 'ObjectLockEnabled: Enabled', 'Mode: !Ref AuditLockMode, Days: !Ref AuditLockDays', 'VersioningConfiguration: {Status: Enabled}', 'SSEAlgorithm: AES256', 'BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true', 'DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain']) assert.ok(bucket.includes(requirement), requirement);
  assert.match(resources.AuditArchiveBucketPolicy, /aws:SecureTransport': 'false'/);
});

test('第9段階 4.6 AuditFunctionは同環境のストリーム読取・2つのS3接頭辞・ログだけを許可する', () => {
  assert.match(resources.AuditFunction, /FunctionName: !Sub 'ht2-\$\{Env\}-audit'/);
  assert.match(resources.AuditFunction, /Handler: src\/audit\/handler.handler/);
  assert.match(resources.AuditFunction, /Role: !GetAtt AuditRole.Arn/);
  const actions = allowed(resources.AuditRole);
  assert.deepEqual([...actions].sort(), ['logs:CreateLogStream', 'logs:PutLogEvents', 'dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams', 's3:PutObject'].sort());
  assert.match(resources.AuditRole, /Resource: !GetAtt Table.StreamArn/);
  assert.match(resources.AuditRole, /Resource: \[!Sub '\$\{AuditArchiveBucket.Arn\}\/audit\/\*', !Sub '\$\{AuditArchiveBucket.Arn\}\/tamper\/\*'\]/);
  assert.doesNotMatch(resources.AuditRole, /ses:|dynamodb:(?:GetItem|PutItem|UpdateItem|DeleteItem|Query|Scan)|s3:(?:DeleteObject|GetObject|BypassGovernanceRetention)/);
  assert.match(resources.WorkerPolicy, /Action: \['s3:ListBucket'\]\n\s+Resource: !GetAtt AuditArchiveBucket.Arn/);
  assert.match(resources.WorkerPolicy, /Action: \['s3:GetObject'\]\n\s+Resource: !Sub '\$\{AuditArchiveBucket.Arn\}\/\*'/);
  assert.doesNotMatch(resources.ApiPolicy, /AuditArchiveBucket/);
});

test('第9段階 4.6 監査Streamsの絞込と無期限再試行・二分割、3つのアラームを定義する', () => {
  const mapping = resources.AuditStreamMapping;
  assert.match(mapping, /EventSourceArn: !GetAtt Table.StreamArn/);
  for (const setting of ['StartingPosition: TRIM_HORIZON', 'BisectBatchOnFunctionError: true', 'MaximumRetryAttempts: -1', 'MaximumRecordAgeInSeconds: -1']) assert.ok(mapping.includes(setting));
  const pattern = JSON.parse(/Pattern: '([^']+)'/.exec(mapping)[1]);
  assert.deepEqual(pattern, { dynamodb: { Keys: { PK: { S: [{ prefix: 'AUDIT#' }] } } } });
  assert.doesNotMatch(mapping, /ReportBatchItemFailures/);
  for (const [name, suffix] of [['AuditTamperAlarm', 'audit-tamper'], ['AuditArchiveLagAlarm', 'audit-archive-lag'], ['AuditArchiveErrorsAlarm', 'audit-archive-errors']]) {
    assert.ok(resources[name].includes(`AlarmName: !Sub 'ht2-\${Env}-${suffix}'`));
    assert.match(resources[name], /AlarmActions: \[!Ref AlertTopic\]/);
  }
  assert.match(resources.AuditTamperAlarm, /Namespace: !Sub 'HT2\/\$\{Env\}'\n      MetricName: AuditTamper/);
  assert.match(resources.AuditArchiveLagAlarm, /Namespace: AWS\/Lambda\n      MetricName: IteratorAge/);
  assert.match(resources.AuditArchiveLagAlarm, /Threshold: 900000\n      ComparisonOperator: GreaterThanThreshold/);
  assert.match(resources.AuditArchiveErrorsAlarm, /MetricName: Errors/);
});

test('第9段階 4.7 AddressHmacSecretと独立したKMS HMAC鍵、最小権限、保持を定義する', () => {
  assert.match(resources.AddressHmacSecret, /Name: !Sub '\/ht2\/\$\{Env\}\/address-hmac'/);
  assert.match(resources.AddressHmacSecret, /SecretStringTemplate: '\{"kid":"k1"\}'/);
  assert.match(resources.AddressHmacSecret, /GenerateStringKey: key\n        PasswordLength: 64\n        ExcludePunctuation: true/);
  for (const requirement of ['KeySpec: HMAC_256', 'KeyUsage: GENERATE_VERIFY_MAC', 'PendingWindowInDays: 30', 'DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain', "Action: 'kms:*'", 'iam::${AWS::AccountId}:root']) assert.ok(resources.EraseMacKey.includes(requirement));
  assert.match(resources.ApiPolicy, /Action: \['kms:GenerateMac'\]\n\s+Resource: !GetAtt EraseMacKey.Arn/);
  assert.match(resources.WorkerPolicy, /Action: \['kms:GenerateMac', 'kms:DescribeKey'\]\n\s+Resource: !GetAtt EraseMacKey.Arn/);
  assert.doesNotMatch(resources.ApiPolicy + resources.WorkerPolicy, /kms:(?:Sign|Decrypt|ScheduleKeyDeletion|DisableKey)|BypassGovernanceRetention/);
  assert.match(resources.WorkerPolicy, /Action: \['dynamodb:DeleteItem'\][\s\S]*?dynamodb:LeadingKeys': \[CONTACT_META\]/);
  assert.doesNotMatch(main, /EraseSecret|erase-hmac|ERASE_SECRET_ARN/);
});

test('第9段階 15.5 全LambdaでFunctionUpdateを既定とし、ARN指定時だけManualに固定する', () => {
  assert.match(blocks(main, 'Parameters').RuntimeVersionArn, /Default: ''/);
  assert.match(main, /HasRuntimeVersion: !Not \[!Equals \[!Ref RuntimeVersionArn, ''\]\]/);
  const functions = Object.values(resources).filter((resource) => resource.includes('Type: AWS::Lambda::Function\n'));
  assert.equal(functions.length, 4);
  for (const fn of functions) assert.match(fn, /RuntimeManagementConfig: !If\n        - HasRuntimeVersion\n        - \{UpdateRuntimeOn: Manual, RuntimeVersionArn: !Ref RuntimeVersionArn\}\n        - \{UpdateRuntimeOn: FunctionUpdate\}/);
});

test('12.1 主スタックとエッジに全必須リソースがある', () => {
  const expected = {
    WebBucket: 'S3::Bucket', DataBucket: 'S3::Bucket', EventLogBucket: 'S3::Bucket', Distribution: 'CloudFront::Distribution',
    UserPool: 'Cognito::UserPool', HttpApi: 'ApiGatewayV2::Api', ApiFunction: 'Lambda::Function', WorkerFunction: 'Lambda::Function',
    BroadcastStateMachine: 'StepFunctions::StateMachine', Table: 'DynamoDB::Table', EmailIdentity: 'SES::EmailIdentity',
    ConfigurationSet: 'SES::ConfigurationSet', ContactList: 'SES::ContactList', EventStream: 'KinesisFirehose::DeliveryStream',
    EventsDatabase: 'Glue::Database', EventsTable: 'Glue::Table', AthenaWorkGroup: 'Athena::WorkGroup',
    ScheduleGroup: 'Scheduler::ScheduleGroup', DailySchedule: 'Scheduler::Schedule',
    OriginSecret: 'SecretsManager::Secret', AddressHmacSecret: 'SecretsManager::Secret', AlertTopic: 'SNS::Topic', AppRecord: 'Route53::RecordSet',
  };
  for (const [name, type] of Object.entries(expected)) assert.ok(resources[name]?.includes(`Type: AWS::${type}\n`), name);
  const e = blocks(edge);
  assert.match(e.Certificate, /AWS::CertificateManager::Certificate/);
  assert.match(e.WebAcl, /AWS::WAFv2::WebACL/);
  // !Ref/!GetAttが未定義の論理名を参照しない。
  for (const source of [main, edge]) {
    const names = new Set([...Object.keys(blocks(source)), ...Object.keys(blocks(source, 'Parameters'))]);
    for (const m of source.matchAll(/!(?:Ref|GetAtt)\s+([A-Za-z][A-Za-z0-9]*)(?:\.|[\s,}\]])/g)) assert.ok(names.has(m[1]), m[1]);
  }
});

test('3.1〜3.4 SES認証・TLS・2発行先・Retain・OPT_OUTとDNS出力', () => {
  assert.match(resources.EmailIdentity, /RSA_2048_BIT/);
  assert.match(resources.EmailIdentity, /SigningEnabled: true/);
  assert.match(resources.EmailIdentity, /BehaviorOnMxFailure: REJECT_MESSAGE/);
  assert.match(resources.EmailIdentity, /ConfigurationSetName: !Ref ConfigurationSet/);
  assert.match(resources.ConfigurationSet, /TlsPolicy: REQUIRE/);
  assert.match(resources.ConfigurationSet, /ReputationMetricsEnabled: true/);
  assert.doesNotMatch(resources.ConfigurationSet, /SuppressionOptions|TrackingOptions/);
  assert.match(resources.ContactList, /DeletionPolicy: RetainExceptOnCreate\n    UpdateReplacePolicy: Retain/);
  assert.equal((resources.ContactList.match(/DefaultSubscriptionStatus: OPT_OUT/g) ?? []).length, 2);
  for (const name of ['CloudWatchDestination', 'FirehoseDestination']) {
    assert.match(resources[name], /Enabled: true/);
    const events = /MatchingEventTypes: \[([^\]]+)\]/.exec(resources[name])[1].split(',').map((s) => s.trim());
    assert.deepEqual(events, REQUIRED_EVENTS);
    assert.doesNotMatch(resources[name], /\b(open|click)\b/);
  }
  assert.match(resources.CloudWatchDestination, /DimensionName: campaign, DimensionValueSource: messageTag, DefaultDimensionValue: none/);
  for (const n of ['Dkim1Name','Dkim1Value','Dkim2Name','Dkim2Value','Dkim3Name','Dkim3Value']) assert.match(outputs[n], /!GetAtt EmailIdentity\.DkimDNSToken/);
  assert.match(outputs.MailFromMx, /10 feedback-smtp\.ap-northeast-1\.amazonses\.com/);
  assert.match(outputs.MailFromSpf, /v=spf1 include:amazonses\.com ~all/);
});

test('4.3〜4.5 PITR、TTL、削除保護、暗号化、公開ブロック、全保持期間', () => {
  assert.match(resources.Table, /PAY_PER_REQUEST/);
  assert.match(resources.Table, /PointInTimeRecoveryEnabled: true/);
  assert.match(resources.Table, /AttributeName: expires_at, Enabled: true/);
  assert.match(resources.Table, /DeletionProtectionEnabled: !If \[IsProd, true, false\]/);
  assert.doesNotMatch(resources.Table, /GlobalSecondaryIndexes/);
  for (const name of ['WebBucket','DataBucket','EventLogBucket']) {
    assert.match(resources[name], /BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true/);
    assert.match(resources[name], /SSEAlgorithm: AES256/);
    assert.match(resources[name], /DeletionPolicy: Retain/);
    assert.match(resources[`${name}Policy`], /aws:SecureTransport/);
  }
  assert.match(resources.WebBucket, /VersioningConfiguration: \{Status: Enabled\}/);
  for (const [prefix, days] of Object.entries({'imports/staging/':7,'imports/ready/':365,'imports/report/':365,'recipients/':30,'results/':180,'backups/contacts/':365,'delivery-checks/':180})) assert.ok(resources.DataBucket.includes(`Prefix: ${prefix}, ExpirationInDays: ${days}`), prefix);
  assert.match(resources.EventLogBucket, /Prefix: ses-events\/, ExpirationInDays: 180/);
  assert.match(resources.DataBucketPolicy, /Principal: \{Service: ses.amazonaws.com\}/);
  assert.match(resources.DataBucketPolicy, /imports\/ready\/\*/);
  assert.match(resources.DataBucketPolicy, /aws:SourceAccount/);
  assert.doesNotMatch(resources.DataBucketPolicy, /aws:SourceArn/);
});

test('7.2 ASLの全差し込み名がDefinitionSubstitutionsと完全一致する', () => {
  const asl = read('infra/broadcast.asl.json');
  JSON.parse(asl);
  const placeholders = [...new Set([...asl.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]))].sort();
  const substitutions = /DefinitionSubstitutions:\n((?:        .+\n)+)/.exec(resources.BroadcastStateMachine)[1];
  assert.deepEqual([...substitutions.matchAll(/^        (\w+):/gm)].map((m) => m[1]).sort(), placeholders);
  assert.match(resources.BroadcastStateMachine, /DefinitionS3Location: broadcast.asl.json/);
  assert.match(resources.BroadcastStateMachine, /StateMachineType: STANDARD/);
  assert.match(resources.BroadcastStateMachine, /Level: ERROR\n        IncludeExecutionData: false/);
  assert.match(resources.WorkerEventInvokeConfig, /MaximumRetryAttempts: 0/);
  assert.match(resources.DailySchedule, /MaximumRetryAttempts: 0/);
  assert.match(resources.DailySchedule, /cron\(0 3 \* \* \? \*\)/);
  assert.match(resources.DailySchedule, /Asia\/Tokyo/);
});

test('8.3 Firehose・Glue日付射影・Athena暗号化とサービス信頼境界', () => {
  assert.match(resources.EventStream, /CompressionFormat: GZIP/);
  assert.match(resources.EventStream, /IntervalInSeconds: 300, SizeInMBs: 5/);
  assert.match(resources.EventStream, /ses-events\/!\{timestamp:yyyy\/MM\/dd\}\//);
  assert.match(resources.EventsTable, /'projection.enabled': 'true'/);
  assert.match(resources.EventsTable, /ses-events\/\$\{dt\}\//);
  for (const field of ['eventtype','mail','bounce','deliverydelay','subscription']) assert.ok(resources.EventsTable.includes(`Name: ${field},`));
  assert.match(resources.AthenaWorkGroup, /EnforceWorkGroupConfiguration: true/);
  assert.match(resources.AthenaWorkGroup, /EncryptionOption: SSE_S3/);
  assert.match(resources.SesFirehoseRole, /aws:SourceAccount/);
  assert.match(resources.SesFirehoseRole, /configuration-set\/ht2-\$\{Env\}/);
  assert.match(resources.SesFirehoseRole, /firehose:PutRecordBatch/);
  assert.doesNotMatch(resources.ApiPolicy + resources.WorkerPolicy, /EventLogBucket|athena:|glue:/);
});

test('11.1 Cognito管理者作成・TOTP・属性制限・PKCE向けクライアント', () => {
  for (const text of ['ESSENTIALS','CaseSensitive: false','AllowAdminCreateUserOnly: true','MinimumLength: 12','TemporaryPasswordValidityDays: 7','SOFTWARE_TOKEN_MFA','AttributesRequireVerificationBeforeUpdate: [email]','DeletionProtection: !If [IsProd, ACTIVE, INACTIVE]']) assert.ok(resources.UserPool.includes(text), text);
  for (const text of ['GenerateSecret: false','AllowedOAuthFlows: [code]','ExplicitAuthFlows: []','WriteAttributes: [name]','AccessTokenValidity: 15','IdTokenValidity: 15','RefreshTokenValidity: 8','RefreshTokenRotation: {Feature: ENABLED','EnableTokenRevocation: true']) assert.ok(resources.WebClient.includes(text), text);
  assert.doesNotMatch(resources.WebClient, /ALLOW_USER|ALLOW_ADMIN|ALLOW_REFRESH_TOKEN_AUTH|implicit/);
  for (const role of ['Admin','Sender','Approver','Viewer']) assert.ok(resources[`${role}Group`]);
});

test('12.3〜12.4 OAC・APIキャッシュ無効・Host除外・JWT・安全なアクセスログ', () => {
  assert.match(resources.OriginAccessControl, /SigningBehavior: always, SigningProtocol: sigv4/);
  assert.match(resources.WebBucketPolicy, /distribution\/\$\{Distribution\}/);
  assert.match(resources.Distribution, /x-origin-verify/);
  assert.match(resources.Distribution, /resolve:secretsmanager:.*:current:\$\{OriginSecretStage\}/);
  assert.match(resources.Distribution, /TLSv1.2_2021/);
  assert.match(resources.ApiCachePolicy, /MinTTL: 0\n        DefaultTTL: 0\n        MaxTTL: 0/);
  assert.match(resources.ApiOriginRequestPolicy, /HeaderBehavior: allExcept, Headers: \[host\]/);
  assert.match(resources.JwtAuthorizer, /AuthorizerType: JWT/);
  assert.match(resources.ApiRoute, /ANY \/api\/\{proxy\+\}/);
  assert.match(resources.ApiRoute, /AuthorizationType: JWT/);
  assert.doesNotMatch(resources.ApiRoute, /RouteKey:.*\$default/);
  assert.doesNotMatch(resources.HttpApi, /CorsConfiguration/);
  assert.doesNotMatch(resources.ApiStage, /\$context\.(path|queryString|requestOverride)|[Bb]ody|[Hh]eader/);
  assert.match(resources.ApiStage, /ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20/);
  for (const header of ['ContentSecurityPolicy','StrictTransportSecurity','FrameOptions','ContentTypeOptions','ReferrerPolicy','Permissions-Policy']) assert.ok(resources.SecurityHeaders.includes(header));
  assert.doesNotMatch(resources.SecurityHeaders, /unsafe-inline/);
});

test('12.3 エッジWAFのルール、本文64KB、APIレート制限、サンプル原文無効', () => {
  for (const rule of ['AWSManagedRulesCommonRuleSet','AWSManagedRulesKnownBadInputsRuleSet','AWSManagedRulesAmazonIpReputationList','KB_64','OversizeHandling: MATCH','Size: 65536','Limit: 1000','EvaluationWindowSec: 300','SearchString: /api/']) assert.ok(edge.includes(rule), rule);
  assert.doesNotMatch(edge, /SampledRequestsEnabled: true/);
});

function allowed(policy) {
  return new Set([...policy.matchAll(/- Effect: Allow\n(?:\s+#[^\n]*\n)*\s+Action: \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
}
const apiOperations = {
  kms: 'GenerateMac',
  ses: 'GetAccount GetEmailIdentity GetConfigurationSet GetConfigurationSetEventDestinations GetContactList ListContacts GetContact CreateContact UpdateContact DeleteContact GetSuppressedDestination GetImportJob CreateEmailTemplate GetEmailTemplate TestRenderEmailTemplate SendEmail',
  ddb: 'GetItem PutItem UpdateItem Query TransactWriteItems', s3: 'PutObject GetObject HeadObject DeleteObject', sns: 'Publish',
  sfn: 'StartExecution DescribeExecution SendTaskSuccess SendTaskFailure', scheduler: 'CreateSchedule DeleteSchedule GetSchedule',
  cognito: 'AdminGetUser AdminListGroupsForUser ListUsersInGroup AdminCreateUser AdminAddUserToGroup AdminRemoveUserFromGroup AdminDisableUser AdminEnableUser AdminUserGlobalSignOut AdminSetUserMFAPreference AdminResetUserPassword', cloudwatch: 'GetMetricData DescribeAlarms', ssm: 'GetParameter', secrets: 'GetSecretValue', lambda: 'Invoke',
};
const workerOperations = {
  kms: 'GenerateMac DescribeKey',
  sfn: 'DescribeExecution', scheduler: 'GetSchedule',
  ses: 'GetAccount GetEmailIdentity GetConfigurationSet GetConfigurationSetEventDestinations GetContactList ListContacts GetContact DeleteContact SendEmail CreateImportJob GetImportJob DeleteEmailTemplate',
  ddb: 'GetItem PutItem UpdateItem DeleteItem Query BatchGetItem', s3: 'PutObject GetObject HeadObject DeleteObject', cloudwatch: 'GetMetricData DescribeAlarms', sns: 'Publish', ssm: 'GetParameter', secrets: 'GetSecretValue',
};
const prefixes = {kms:'kms',ses:'ses',ddb:'dynamodb',s3:'s3',sfn:'states',scheduler:'scheduler',cognito:'cognito-idp',cloudwatch:'cloudwatch',sns:'sns',ssm:'ssm',secrets:'secretsmanager',lambda:'lambda'};
const iamOperation = (service, operation) => service === 's3' && operation === 'HeadObject' ? 'GetObject' : service === 'lambda' && operation === 'Invoke' ? 'InvokeFunction' : service === 'ddb' && operation === 'TransactWriteItems' ? 'PutItem' : operation;

for (const [name, operations] of [['Api',apiOperations],['Worker',workerOperations]]) {
  test(`12.6 ${name} IAMの許可操作を設計表とaws.jsの全操作へ照合（過不足なし）`, () => {
    const expected = new Set(['logs:CreateLogStream','logs:PutLogEvents','s3:ListBucket', ...(name === 'Api' ? ['iam:PassRole'] : [])]);
    for (const [service, list] of Object.entries(operations)) for (const operation of list.split(' ')) {
      assert.ok(AWS_APIS[service].operations.includes(operation), `${service}.${operation}`);
      expected.add(`${prefixes[service]}:${iamOperation(service, operation)}`);
    }
    assert.deepEqual([...allowed(resources[`${name}Policy`])].sort(), [...expected].sort());
    assert.doesNotMatch(resources[`${name}Policy`], /s3:HeadObject|lambda:Invoke'|dynamodb:TransactWriteItems'/);
  });
}

test('12.6 aws.jsの全SDK操作が少なくとも一方のIAM照合に含まれる', () => {
  for (const [service, {operations}] of Object.entries(AWS_APIS)) for (const op of operations) assert.ok([apiOperations,workerOperations].some((x) => x[service]?.split(' ').includes(op)), `${service}.${op}`);
  assert.match(read('src/api/routes/imports.js'), /TransactItems: \[\s*\{ Put:[\s\S]*?\{ Put:/);
});

test('12.6 開始照合の読取権限はAPI・workerの同環境の実行と予約だけに限定する', () => {
  for (const policy of [resources.ApiPolicy, resources.WorkerPolicy]) {
    assert.match(policy, /Action: \['states:DescribeExecution'\]\n\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:states:\$\{AWS::Region\}:\$\{AWS::AccountId\}:execution:ht2-\$\{Env\}:\*'/);
    assert.match(policy, /Action: \[[^\]\n]*'scheduler:GetSchedule'[^\]\n]*\]\n\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:scheduler:\$\{AWS::Region\}:\$\{AWS::AccountId\}:schedule\/ht2-\$\{Env\}\/ht2-\*'/);
  }
  assert.doesNotMatch(resources.StateMachinePolicy, /states:DescribeExecution|scheduler:GetSchedule/);
  assert.match(resources.WorkerFunction, /STATE_MACHINE_ARN:/);
  assert.match(resources.WorkerFunction, /SCHEDULE_GROUP:/);
});

test('12.6 共通拒否・固定テンプレート・監査ログの拒否とSendEmailのリソース制限', () => {
  for (const name of ['ApiPolicy','WorkerPolicy']) {
    const p = resources[name];
    assert.match(p, /Sid: DenyDestructiveSes\n\s+Effect: Deny/);
    for (const action of ['DeleteContactList','UpdateContactList','DeleteEmailIdentity','DeleteSuppressedDestination','PutAccount*']) assert.ok(p.includes(`'ses:${action}'`), action);
    assert.match(p, /Sid: DenyAuditMutation\n\s+Effect: Deny/);
    assert.match(p, /ForAnyValue:StringLike.*dynamodb:LeadingKeys.*AUDIT#\*/);
    assert.match(p, /Sid: DenyFixedTemplateMutation\n\s+Effect: Deny/);
    assert.match(p, /Action: \['ses:SendEmail'\]\n\s+Resource: \[!If \[IsProd, !Sub '.*identity\/\$\{SenderDomain\}'.*configuration-set\/ht2-\$\{Env\}.*contact-list\/ht2.*template\/ht2-c-\*/);
    assert.match(p, /ses:FromAddress/);
  }
  assert.match(resources.ApiPolicy, /Action: \['ses:UpdateEmailTemplate', 'ses:DeleteEmailTemplate'\]/);
  assert.match(resources.WorkerPolicy, /Action: \['ses:DeleteEmailTemplate'\]\n\s+Resource:.*template\/ht2-c-\*/);
  for (const name of ['ApiPolicy', 'WorkerPolicy']) assert.match(resources[name], /identity\/\*'\]/);
});

test('12.6 引継ぎの限定S3読取・PassRole・通知と環境変数を実装に照合', () => {
  for (const prefix of ['results/*','delivery-checks/*','imports/report/*','recipients/*']) assert.ok(resources.ApiPolicy.includes(`\${DataBucket.Arn}/${prefix}`));
  assert.match(resources.WorkerPolicy, /Action: \['s3:GetObject'\]\n\s+Resource:.*delivery-checks\/\*/);
  assert.doesNotMatch(/Action: \['s3:PutObject'\]\n\s+Resource:([^\n]+)/.exec(resources.WorkerPolicy)[1], /delivery-checks/);
  assert.match(resources.ApiPolicy, /iam:PassedToService.*scheduler.amazonaws.com/);
  assert.match(resources.WorkerPolicy, /sns:Publish/);
  const sources = readdirSync(new URL('../../src/', import.meta.url), {recursive:true}).filter((n) => n.endsWith('.js')).map((n) => read(`src/${n.replaceAll('\\','/')}`)).join('\n');
  const envs = new Set([...sources.matchAll(/environment\.([A-Z][A-Z_]+)/g)].map((m) => m[1]));
  for (const name of ['CONFIG_PARAM','ORIGIN_SECRET_ARN','ADDRESS_HMAC_SECRET_ARN','LOG_LEVEL']) envs.add(name);
  for (const fn of ['ApiFunction','WorkerFunction']) for (const name of envs) {
    if (name === 'AUDIT_ARCHIVE_BUCKET' && fn === 'ApiFunction') continue;
    if (name !== 'AWS_REGION') assert.ok(resources[fn].includes(`          ${name}:`), `${fn}.${name}`);
  }
  for (const fn of ['ApiFunction','WorkerFunction']) {
    assert.match(resources[fn], /Runtime: nodejs24.x/);
    assert.match(resources[fn], /Architectures: \[arm64\]/);
    assert.doesNotMatch(resources[fn], /VpcConfig/);
  }
  assert.match(resources.WorkerFunction, /ReservedConcurrentExecutions: !If \[HasWorkerReservedConcurrency, !Ref WorkerReservedConcurrency, !Ref 'AWS::NoValue'\]/);
  assert.match(blocks(main, 'Parameters').WorkerReservedConcurrency, /Default: -1/);
});

test('12.7 初期設定は送信無効、SSMの全設定キーを実装の検証器で検査', () => {
  const source = /\{"sending_enabled":.+\}/.exec(read('scripts/bootstrap-config.sh'))[0];
  for (const env of ['dev','stg','prod']) {
    const settings = JSON.parse(source.replaceAll('${ENV}',env).replace('${IsProduction}',String(env === 'prod')));
    assert.deepEqual(Object.keys(settings).sort(), Object.keys(configDefaults(env)).sort());
    validateConfig(settings,env);
    assert.equal(settings.sending_enabled,false);
    assert.equal(settings.delivery_check_required,env === 'prod');
  }
  assert.match(resources.AddressHmacSecret, /DeletionPolicy: Retain/);
  assert.equal(blocks(main, 'Parameters').EraseHmacKey, undefined);
  assert.equal(resources.ConfigParameter, undefined);
  assert.match(resources.AddressHmacSecret, /GenerateStringKey: key\n        PasswordLength: 64\n        ExcludePunctuation: true/);
  assert.doesNotMatch(resources.AddressHmacSecret, /\n      SecretString:/);
  assert.match(outputs.ConfigParameterName, /!Sub '\/ht2\/\$\{Env\}\/config'/);
});

test('12.8 環境別アカウント例・リージョン固定・全パラメータの定義一致', () => {
  const params = blocks(main,'Parameters');
  const accounts = new Set();
  const zones = new Set();
  for (const env of ['dev','stg','prod']) {
    const entries = JSON.parse(read(`infra/params/${env}.json`));
    assert.deepEqual(entries.map((p) => p.ParameterKey).sort(), Object.keys(params).sort());
    const values = Object.fromEntries(entries.map((p) => [p.ParameterKey,p.ParameterValue]));
    assert.equal(values.Env,env);
    assert.equal(values.Topic1Display,'会報');
    assert.equal(values.Topic2Display,'イベント・チケット情報');
    assert.ok(values.AppDomain.includes('example') && values.SenderDomain.includes('example'));
    assert.equal(values.EraseHmacKey, undefined);
    assert.equal(values.WorkerReservedConcurrency, '-1');
    zones.add(values.HostedZoneId);
    for (const key of ['CertificateArn', 'WebAclArn']) {
      const pattern = /AllowedPattern: '([^']+)'/.exec(params[key])[1];
      assert.equal(new RegExp('^' + pattern + '$').test(values[key]), false);
    }
    const edgeParams = JSON.parse(read(`infra/params/${env}.edge.json`));
    assert.deepEqual(edgeParams.map((p) => p.ParameterKey).sort(), Object.keys(blocks(edge, 'Parameters')).sort());
    for (const entry of edgeParams) assert.equal(entry.ParameterValue, values[entry.ParameterKey]);
    accounts.add(values.ExpectedAccountId);
  }
  assert.equal(accounts.size,3);
  assert.equal(zones.size,3);
  assert.match(main, /!Ref 'AWS::Region', ap-northeast-1/);
  assert.match(edge, /!Ref 'AWS::Region', us-east-1/);
  assert.match(main, /!Ref 'AWS::AccountId', !Ref ExpectedAccountId/);
});

test('13.3 アラームの物理名・しきい値・missingとUSER以外の停止通知', () => {
  for (const suffix of ['ses-bounce-rate','ses-complaint-rate','needs-review','unknown-results','paused-by-system','sfn-failed','api-lambda-errors','worker-lambda-errors','ses-busy','firehose-delivery','firehose-freshness','rendering-or-reject','api-5xx']) assert.ok(main.includes(`ht2-\${Env}-${suffix}'`), suffix);
  for (const name of ['SesBounceRateAlarm','SesComplaintRateAlarm']) assert.match(resources[name], /TreatMissingData: ignore/);
  for (const name of ['FirehoseDeliveryAlarm','FirehoseFreshnessAlarm']) assert.match(resources[name], /TreatMissingData: missing/);
  assert.match(resources.SesBounceRateAlarm, /Threshold: 0.03/);
  assert.match(resources.SesComplaintRateAlarm, /Threshold: 0.0008/);
  assert.match(resources.FirehoseDeliveryAlarm, /Statistic: Minimum/);
  assert.match(resources.FirehoseFreshnessAlarm, /Threshold: 900/);
  assert.match(resources.PausedBySystemAlarm, /AWS::CloudWatch::CompositeAlarm/);
  assert.doesNotMatch(Object.entries(resources).filter(([key]) => key.startsWith('SystemPauseReason')).map(([,v]) => v).join('\n'), /Value: USER/);
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : 'bash';
const root = new URL('../../',import.meta.url);
function runScript(script, args = [], env = {}, input = '') {
  mkdirSync(new URL('build/',root),{recursive:true});
  const callsPath = new URL('build/infra-mock-calls.txt',root);
  writeFileSync(callsPath,'');
  const result = spawnSync(bash, ['-c', 'source test/helpers/infra-aws.sh; source "scripts/$1" "${@:2}"', 'infra-test',script,...args], {
    cwd:root, encoding:'utf8', input,
    env:{...process.env,HT2_ACCOUNT_ID:'111111111111',ARTIFACT_BUCKET:'example-artifacts',HT2_PARAMS:'infra/params/dev.json',HT2_EDGE_PARAMS:'infra/params/dev.edge.json',MOCK_CALLS:'build/infra-mock-calls.txt',...env},
  });
  assert.ifError(result.error);
  return {...result,calls:readFileSync(callsPath,'utf8')};
}

function preserveWebConfig(t) {
  const path = new URL('web/config.json', root);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  t.after(() => {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
  });
}

test('第11段階 staff.shは確認文字列と内部Usernameを使い、CRLFを除いて管理者を作成する', () => {
  const result = runScript('staff.sh', ['dev', 'create-admin', 'admin@example.com', '運営者'], { MOCK_STAFF_USERNAME: 'staff-uuid\r' }, 'create-admin 111111111111\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /cognito-idp admin-create-user .*--user-pool-id ap-northeast-1_example --username admin@example.com/);
  assert.match(result.calls, /cognito-idp admin-add-user-to-group .*--username staff-uuid --group-name admin/);
  assert.doesNotMatch(result.calls, /\r|--temporary-password|admin-delete-user|update-user-pool/);
  const rejected = runScript('staff.sh', ['dev', 'create-admin', 'admin@example.com', '運営者'], {}, 'wrong\n');
  assert.notEqual(rejected.status, 0); assert.doesNotMatch(rejected.calls, /admin-create-user/);
});

test('第11段階 staff.shの復旧はMFA無効化の後にサインアウトし、有効化は専用APIだけを使う', () => {
  const mfa = runScript('staff.sh', ['dev', 'reset-mfa', 'staff-uuid'], {}, 'reset-mfa 111111111111 staff-uuid\n');
  assert.equal(mfa.status, 0, mfa.stderr);
  assert.match(mfa.calls, /admin-set-user-mfa-preference .*Enabled=false,PreferredMfa=false[\s\S]*admin-user-global-sign-out/);
  const enabled = runScript('staff.sh', ['dev', 'enable', 'staff-uuid'], {}, 'enable 111111111111 staff-uuid\n');
  assert.equal(enabled.status, 0, enabled.stderr); assert.match(enabled.calls, /admin-enable-user/);
  for (const [action, username] of [['enable', 'member@example.com'], ['delete', 'staff-uuid']]) {
    const rejected = runScript('staff.sh', ['dev', action, username]);
    assert.notEqual(rejected.status, 0); assert.doesNotMatch(rejected.calls, /cognito-idp/);
  }
});

for (const state of ['QUEUED', 'SENDING', 'SCHEDULED']) test(`T-68 deployは${state}の配信IDを出し、変更セット作成前に止まる`, () => {
  const epoch = 1793664000;
  const scheduled = new Date((epoch + 3600) * 1000).toISOString();
  const id = '01K9542S00AAAAAAAAAAAAAAAA';
  const r = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], { MOCK_EPOCH: String(epoch), MOCK_CAMPAIGNS: `${id}\t${state}\t${state === 'SCHEDULED' ? scheduled : 'None'}\n` });
  assert.notEqual(r.status, 0); assert.match(r.stderr, new RegExp(`DEPLOY_BLOCKED ${id} ${state}`));
  assert.doesNotMatch(r.calls, /cloudformation (?:package|create-change-set)/);
  assert.match(r.calls, /dynamodb query .*--consistent-read/);
});

test('T-68 deployは60分より先の予約を許可し、取得不能・日時不明は拒否する', () => {
  const epoch = 1793664000; const id = '01K9542S00AAAAAAAAAAAAAAAA';
  const allowed = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], { MOCK_EPOCH: String(epoch), MOCK_CAMPAIGNS: `${id}\tSCHEDULED\t${new Date((epoch + 3601) * 1000).toISOString()}\n` });
  assert.equal(allowed.status, 0, allowed.stderr); assert.match(allowed.calls, /create-change-set/);
  for (const env of [{ MOCK_CAMPAIGN_ERROR: '1' }, { MOCK_CAMPAIGNS: `${id}\tSCHEDULED\tNone\n` }]) {
    const r = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], env);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /DEPLOY_BLOCKED/); assert.doesNotMatch(r.calls, /create-change-set/);
  }
});

for (const state of ['PAUSED', 'NEEDS_REVIEW']) test(`T-68 deployは${state}を一覧表示し、明示的な確認文字列で続行する`, () => {
  const id = '01K9542S00AAAAAAAAAAAAAAAA'; const env = { MOCK_CAMPAIGNS: `${id}\t${state}\tNone\n` };
  const stopped = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], env, 'yes\n');
  assert.notEqual(stopped.status, 0); assert.doesNotMatch(stopped.calls, /create-change-set/);
  const confirmed = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], env, 'deploy ht2-main-dev stopped\n');
  assert.equal(confirmed.status, 0, confirmed.stderr); assert.match(confirmed.stderr, new RegExp(`${id} ${state}`)); assert.match(confirmed.calls, /create-change-set/);
});

test('T-68 初回スタック作成は配信点検を省き、executeでも配信を再点検する', () => {
  const first = runScript('deploy.sh', ['dev', 'prepare', 'example-review'], { MOCK_STATUS: 'None', MOCK_CAMPAIGN_ERROR: '1' });
  assert.equal(first.status, 0, first.stderr); assert.doesNotMatch(first.calls, /dynamodb query/);
  const execute = runScript('deploy.sh', ['dev', 'execute', 'example-review'], { MOCK_CAMPAIGNS: '01K9542S00AAAAAAAAAAAAAAAA\tSENDING\tNone\n' }, 'execute ht2-main-dev example-review\n');
  assert.notEqual(execute.status, 0); assert.doesNotMatch(execute.calls, /execute-change-set/);
});

test('15.5 smokeは全関数の実行環境ARNとSDK版を保存し、前回との差を表示する', () => {
  const previous = new URL('build/dev.sdk-check.json', root);
  const sdk = { ok: true, packages: [{ package: '@aws-sdk/client-kms', ok: true, version: '3.1.0' }] };
  const r = runScript('smoke.sh', ['dev'], { MOCK_SDK_RESULT: JSON.stringify(sdk), MOCK_RUNTIME_ARN: 'arn:aws:lambda:ap-northeast-1::runtime:123abc' });
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(previous, 'utf8'));
  assert.deepEqual(Object.keys(saved.runtime_versions).sort(), ['ht2-dev-api', 'ht2-dev-audit', 'ht2-dev-worker']);
  assert.deepEqual(saved.sdk_check, sdk);
  assert.equal((r.calls.match(/lambda get-function-configuration/g) ?? []).length, 3);
  const same = runScript('smoke.sh', ['dev'], { MOCK_SDK_RESULT: JSON.stringify(sdk), MOCK_RUNTIME_ARN: 'arn:aws:lambda:ap-northeast-1::runtime:123abc' });
  assert.equal(same.status, 0, same.stderr); assert.doesNotMatch(same.stdout, /versions changed/);
  const changed = runScript('smoke.sh', ['dev'], { MOCK_SDK_RESULT: JSON.stringify({ ...sdk, packages: [{ ...sdk.packages[0], version: '3.2.0' }] }), MOCK_RUNTIME_ARN: 'arn:aws:lambda:ap-northeast-1::runtime:abcdef' });
  assert.equal(changed.status, 0, changed.stderr); assert.match(changed.stdout, /Runtime\/SDK versions changed/); assert.match(changed.stdout, /3.1.0/); assert.match(changed.stdout, /3.2.0/);
  const before = readFileSync(previous, 'utf8');
  const failed = runScript('smoke.sh', ['dev'], { MOCK_RUNTIME_ARN: 'None' });
  assert.notEqual(failed.status, 0); assert.equal(readFileSync(previous, 'utf8'), before);
});

test('15.3 全スクリプトはstrict bashで、AWS CLI以外の実行環境・外部パッケージ不要', () => {
  for (const name of scripts) {
    const source=read(`scripts/${name}`);
    if (name === 'env.sh') assert.doesNotMatch(source, /\bset\s+-|\bexit\b/);
    else assert.ok(source.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n'),name);
    assert.doesNotMatch(source, /(?:^|[;|&]|\$\()\s*(?:npm|npx|jq|python3?|node|curl|zip|sam|terraform|cdk)\s/m);
    const result=spawnSync(bash,['-n',`scripts/${name}`],{cwd:root,encoding:'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status,0,`${name}: ${result.stderr}`);
  }
});

test('15.3 packageは最新のsrcとpackage.jsonだけをbackendへそろえる', () => {
  mkdirSync(new URL('build/backend/src/', root), { recursive: true });
  writeFileSync(new URL('build/backend/src/stale.js', root), 'stale');
  const result = spawnSync(bash, ['scripts/package.sh'], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const expected = ['package.json', ...readdirSync(new URL('src/', root), { recursive: true }).filter((n) => n.endsWith('.js')).map((n) => 'src/' + n.replaceAll('\\', '/'))].sort();
  const actual = readdirSync(new URL('build/backend/', root), { recursive: true }).map((n) => n.replaceAll('\\', '/')).filter((n) => n.endsWith('.js') || n === 'package.json').sort();
  assert.deepEqual(actual, expected);
  for (const name of actual) assert.deepEqual(readFileSync(new URL('build/backend/' + name, root)), readFileSync(new URL(name, root)), name);
  for (const fn of ['ApiFunction', 'WorkerFunction']) assert.match(resources[fn], /Code: \.\.\/build\/backend\//);
});

test('15.3 deploy prepareは変更セットを作って止まり、自動実行しない', () => {
  const r=runScript('deploy.sh',['dev','prepare','example-review']);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.calls,/cloudformation create-change-set/);
  assert.match(r.calls,/--template-url https:/);
  assert.doesNotMatch(r.calls,/execute-change-set/);
});

test('15.3 トピック削除・リスト削除/置換・照会失敗をprepare/executeで拒否', () => {
  for(const action of ['prepare','execute']) for(const env of [{MOCK_TOPICS:'kaiho'},{MOCK_CONTACT_CHANGE:'Remove False'},{MOCK_CONTACT_CHANGE:'Modify True'},{MOCK_QUERY_FAIL:'1'},{MOCK_DECLARATION_CHANGE:'1'}]) {
    const r=runScript('deploy.sh',['dev',action,'example-review'],env,'execute ht2-main-dev example-review\n');
    assert.notEqual(r.status,0,`${action} ${JSON.stringify(env)}`);
    assert.doesNotMatch(r.calls,/execute-change-set/);
  }
});

test('15.3 レビュー済みの明示的executeだけが変更セットを実行する', () => {
  const r=runScript('deploy.sh',['dev','execute','example-review'],{},'execute ht2-main-dev example-review\n');
  assert.equal(r.status,0,r.stderr);
  assert.match(r.calls,/execute-change-set/);
  const wrong=runScript('deploy.sh',['dev','execute','example-review'],{},'yes\n');
  assert.notEqual(wrong.status,0);
  assert.doesNotMatch(wrong.calls,/execute-change-set/);
});

test('12.8 スクリプトはAWSアカウント不一致で変更前に止まる', () => {
  const r=runScript('deploy.sh',['dev','prepare','example-review'],{MOCK_ACCOUNT:'222222222222'});
  assert.notEqual(r.status,0);
  assert.doesNotMatch(r.calls,/create-change-set|s3 cp/);
});

test('15.3 web/config.jsonは出力から生成され、秘密が含まれない', () => {
  const p=new URL('web/config.json',root);
  const previous=existsSync(p)?readFileSync(p):undefined;
  try {
    const r=runScript('deploy-web.sh',['dev','config-only']);
    assert.equal(r.status,0,r.stderr);
    const c=JSON.parse(readFileSync(p,'utf8'));
    assert.equal(c.clientId,'exampleclient123');
    assert.equal(c.apiBaseUrl,'/api/v1');
    assert.equal(c.senderDomain,'fc.dev.example.jp');
    assert.equal(c.redirectUri,'https://app.dev.example.jp/callback.html');
    assert.equal(c.env,'dev');
    assert.doesNotMatch(JSON.stringify(c),/secret|token|password/i);
    assert.doesNotMatch(r.calls,/secretsmanager|s3 cp|s3 sync/);
  } finally { if(previous) writeFileSync(p,previous); else rmSync(p,{force:true}); }
});

test('13.5 復元は送信無効・API凍結・排他・証跡・明示確認を必須にする', () => {
  for(const env of [{MOCK_SENDING:'true'},{MOCK_CONCURRENCY:'3'},{MOCK_OWNER:'existing-import'}]) {
    const r=runScript('restore-contacts.sh',['dev','import','package.json','delivery-checks/review.json'],env,'restore 111111111111 dev\n');
    assert.notEqual(r.status,0);
    assert.doesNotMatch(r.calls,/create-import-job/);
  }
  const r=runScript('restore-contacts.sh',['dev','import','package.json','delivery-checks/review.json'],{},'restore 111111111111 dev\n');
  assert.equal(r.status,0,r.stderr);
  assert.match(r.calls,/create-import-job/);
  assert.doesNotMatch(r.calls,/delete-suppressed|put-parameter|delete-function-concurrency/);
  assert.match(read('scripts/restore-contacts.sh'), /--condition-expression/);
});

test('13.5 インポート完了前は停止差分を適用せず、適用は全停止側だけへ倒す', () => {
  writeFileSync(new URL('build/example-stops.tsv',root),'member@example.jp\tkaiho\n');
  const blocked=runScript('restore-contacts.sh',['dev','apply-stops','build/example-stops.tsv','example-job'],{MOCK_JOB_STATUS:'PROCESSING'});
  assert.notEqual(blocked.status,0);
  assert.doesNotMatch(blocked.calls,/update-contact/);
  const result=runScript('restore-contacts.sh',['dev','apply-stops','build/example-stops.tsv','example-job']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.calls,/sesv2 update-contact .*--unsubscribe-all/);
  assert.doesNotMatch(result.calls,/--no-unsubscribe-all|delete-suppressed/);
  assert.match(result.calls, /merge\(.*TopicPreferences.*AttributesData/);
  const payload = JSON.parse(read('build/dev.restore-contact.json'));
  assert.deepEqual(payload.TopicPreferences, [{ TopicName: 'kaiho', SubscriptionStatus: 'OPT_OUT' }, { TopicName: 'event', SubscriptionStatus: 'OPT_IN' }]);
  assert.deepEqual(JSON.parse(payload.AttributesData), { name: '会員', consent: { source: '入会' } });
});

test('18.2 技術資料は全U-xxを実機確認として残す', () => {
  const text=read('docs/構築手順書.md');
  for(let i=1;i<=10;i++) assert.ok(text.includes(`U-${String(i).padStart(2,'0')}`));
  assert.match(text,/実機で確認/);
  assert.match(read('docs/運用手順書.md'),/実機で確認/);
});

test('13.2 カスタムアラームの名前空間とメトリクス名を出力実装と照合', async () => {
  const { createMetrics } = await import('../../src/common/metrics.js');
  for (const [resource, metric] of [['NeedsReviewAlarm', 'NeedsReview'], ['UnknownResultsAlarm', 'Unknown'], ['SesBusyAlarm', 'SesBusy']]) {
    const entry = createMetrics({ env: 'dev', write: () => {} }).emit(metric);
    assert.ok(resources[resource].includes(`Namespace: !Sub '${entry._aws.CloudWatchMetrics[0].Namespace.replace('dev', '${Env}')}'`));
    assert.ok(resources[resource].includes(`MetricName: ${metric}\n`));
  }
});

test('4.3・12.7 保持資源は初回作成失敗だけ削除し、更新置換では保持', () => {
  for (const name of ['WebBucket', 'DataBucket', 'EventLogBucket', 'Table', 'ContactList', 'UserPool', 'OriginSecret', 'AddressHmacSecret']) {
    assert.match(resources[name], /DeletionPolicy: RetainExceptOnCreate\n    UpdateReplacePolicy: Retain/);
  }
  for (const [name, resource] of Object.entries(resources)) if (!['AuditArchiveBucket', 'EraseMacKey'].includes(name)) assert.doesNotMatch(resource, /DeletionPolicy: Retain\n/);
  assert.doesNotMatch(main, /AWS::SSM::Parameter/);
});

test('12.6 ListBucketはDataBucketだけに許可し、GetObjectの不存在判定にprefix条件を使わない', () => {
  for (const name of ['ApiPolicy', 'WorkerPolicy']) {
    assert.match(resources[name], /Action: \['s3:ListBucket'\]\n\s+Resource: !GetAtt DataBucket.Arn\n\s+- /);
    assert.doesNotMatch(resources[name], /s3:prefix/);
  }
});

test('8.3 Subscriptionは新旧とも実イベントの購読状態と既定状態を保持', () => {
  const column = resources.EventsTable.split('\n').find((line) => line.includes('Name: subscription,'));
  for (const name of ['oldtopicpreferences', 'newtopicpreferences']) assert.ok(column.includes(`${name}:struct<unsubscribeall:boolean,topicsubscriptionstatus:array<struct<topicname:string,subscriptionstatus:string>>,topicdefaultsubscriptionstatus:array<struct<topicname:string,subscriptionstatus:string>>>`));
  assert.doesNotMatch(column, /[<,]topicpreferences:/);
});

test('15.4 設定初期化は未作成時だけ作り、既存設定・照会障害・作成競合を上書きしない', () => {
  const existing = runScript('bootstrap-config.sh', ['dev']);
  assert.equal(existing.status, 0, existing.stderr);
  assert.doesNotMatch(existing.calls, /put-parameter/);
  for (const env of ['dev', 'stg', 'prod']) {
    const created = runScript('bootstrap-config.sh', [env], { MOCK_CONFIG: 'missing' });
    assert.equal(created.status, 0, created.stderr);
    const config = JSON.parse(read(`build/${env}.config.initial.json`));
    assert.deepEqual(config, configDefaults(env));
    assert.match(created.calls, /ssm put-parameter/);
    assert.doesNotMatch(created.calls, /--overwrite/);
  }
  for (const MOCK_CONFIG of ['denied', 'network']) {
    const r = runScript('bootstrap-config.sh', ['dev'], { MOCK_CONFIG });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.calls, /put-parameter/);
  }
  const race = runScript('bootstrap-config.sh', ['dev'], { MOCK_CONFIG: 'missing', MOCK_CONFIG_RACE: '1' });
  assert.notEqual(race.status, 0);
  assert.equal((race.calls.match(/put-parameter/g) ?? []).length, 1);
});

test('15.3 主・エッジprepareはREVIEW_IN_PROGRESSをCREATE、ROLLBACK_COMPLETEを停止', () => {
  for (const script of ['deploy.sh', 'deploy-edge.sh']) {
    for (const MOCK_STATUS of ['None', 'REVIEW_IN_PROGRESS']) {
      const r = runScript(script, ['dev', 'prepare', 'review-create'], { MOCK_STATUS });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.calls, /--change-set-type CREATE/);
      assert.doesNotMatch(r.calls, /execute-change-set/);
    }
    for (const action of ['prepare', 'execute']) {
      const r = runScript(script, ['dev', action, 'review-failed'], { MOCK_STATUS: 'ROLLBACK_COMPLETE' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /delete the failed stack explicitly/);
      assert.doesNotMatch(r.calls, /create-change-set|execute-change-set|s3 cp/);
    }
  }
});

test('15.3 エッジはus-east-1でレビュー後だけ実行し、主へARNを渡す', () => {
  const prepared = runScript('deploy-edge.sh', ['dev', 'prepare', 'edge-reviewed']);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.calls, /--region us-east-1 --stack-name ht2-edge-dev/);
  assert.doesNotMatch(prepared.calls, /execute-change-set/);
  const rejected = runScript('deploy-edge.sh', ['dev', 'execute', 'edge-reviewed'], {}, 'yes\n');
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.calls, /execute-change-set/);
  const executed = runScript('deploy-edge.sh', ['dev', 'execute', 'edge-reviewed'], { MOCK_STATUS: 'REVIEW_IN_PROGRESS' }, 'execute ht2-edge-dev edge-reviewed\n');
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.calls, /wait stack-create-complete/);
  const mainPrepared = runScript('deploy.sh', ['dev', 'prepare', 'main-reviewed']);
  assert.equal(mainPrepared.status, 0, mainPrepared.stderr);
  const values = Object.fromEntries(JSON.parse(read('build/dev.main.resolved.params.json')).map((p) => [p.ParameterKey, p.ParameterValue]));
  assert.match(values.CertificateArn, /^arn:aws:acm:us-east-1:111111111111:certificate\//);
  assert.match(values.WebAclArn, /^arn:aws:wafv2:us-east-1:111111111111:global\/webacl\//);
  assert.match(mainPrepared.calls, /--parameters file:\/\/build\/dev.main.resolved.params.json/);
});

test('15.3 WindowsのCRLF出力でもアカウント・出力・Topics・復元を照合できる', (t) => {
  preserveWebConfig(t);
  for (const [script, args] of [
    ['deploy.sh', ['dev', 'prepare', 'crlf-review']],
    ['deploy-edge.sh', ['dev', 'prepare', 'crlf-edge']],
    ['deploy-web.sh', ['dev', 'config-only']],
    ['bootstrap-config.sh', ['dev']],
    ['restore-contacts.sh', ['dev', 'status', 'job-id']],
  ]) {
    const r = runScript(script, args, { MOCK_CRLF: '1' });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
  assert.match(read('scripts/common.sh'), /AWS_CLI_FILE_ENCODING=UTF-8/);
  for (const name of scripts.filter((name) => !['common.sh', 'env.sh'].includes(name))) assert.doesNotMatch(read(`scripts/${name}`), /\$\(aws\s|< <\(aws\s/);
});

test('15.3 画面は拡張子別Content-Typeと再検証キャッシュ指定で公開', (t) => {
  preserveWebConfig(t);
  const result = runScript('deploy-web.sh', ['dev'], { MOCK_CRLF: '1' });
  assert.equal(result.status, 0, result.stderr);
  for (const [extension, type] of [['html', 'text/html'], ['js', 'application/javascript'], ['css', 'text/css'], ['json', 'application/json']]) {
    assert.ok(result.calls.includes(`--include *.${extension} --content-type ${type}; charset=utf-8 --cache-control no-cache,max-age=0,must-revalidate`));
  }
  assert.match(result.calls, /cloudfront create-invalidation/);
  assert.match(result.calls, /cloudfront wait invalidation-completed .*--id EXAMPLEINVALIDATION/);
});

test('13.5 連絡先の読取失敗時は更新せず、未設定属性は追加しない', () => {
  writeFileSync(new URL('build/example-stops.tsv', root), 'member@example.jp\tALL\n');
  const failed = runScript('restore-contacts.sh', ['dev', 'apply-stops', 'build/example-stops.tsv', 'example-job'], { MOCK_CONTACT_ERROR: '1' });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.calls, /update-contact/);
  const absent = runScript('restore-contacts.sh', ['dev', 'apply-stops', 'build/example-stops.tsv', 'example-job'], { MOCK_CONTACT_NO_ATTR: '1' });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(JSON.parse(read('build/dev.restore-contact.json')).AttributesData, undefined);
});

test('legacy backup export marks unknown completeness and still retrieves durable attributes; access failures stop', () => {
  const legacy = runScript('restore-contacts.sh', ['dev', 'export', '2026-10-01', '202610'], { MOCK_MANIFEST_ERROR: '404' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(JSON.parse(read('build/restore-dev-2026-10-01/contacts.manifest.json')), { complete: false, legacy: true, reason: 'MANIFEST_MISSING' });
  assert.match(legacy.calls, /dynamodb query .*--consistent-read .*CONTACT_META/);
  assert.match(legacy.calls, /dynamodb query .*ERASED/);
  assert.doesNotMatch(legacy.calls, /create-import-job|update-contact/);
  const denied = runScript('restore-contacts.sh', ['dev', 'export', '2026-10-01', '202610'], { MOCK_MANIFEST_ERROR: '403' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Cannot read backup manifest/);
  assert.doesNotMatch(denied.calls, /create-import-job|update-contact/);
});

test('第6段階の資料は現行の構築・画面・鍵・イベント手順と実機確認を示す', () => {
  const build = read('docs/構築手順書.md');
  const operations = read('docs/運用手順書.md');
  for (const term of ['deploy-edge.sh', 'bootstrap-config.sh', 'GenerateSecretString', 'WorkerReservedConcurrency', 'AWS_CLI_FILE_ENCODING=UTF-8', 'カスタムメトリクスが出ること', 'topicSubscriptionStatus', 'topicDefaultSubscriptionStatus', 'ListBucket', '確認すること']) assert.ok(build.includes(term), term);
  assert.match(build, /"MailType": "MARKETING"/);
  assert.doesNotMatch(build, /画面本体がまだない|UsePreviousValue|HT2_HMAC|"TRANSACTIONAL"/);
  for (const term of ['OptIn/OptOut', 'OPT_IN/OPT_OUT', 'topicSubscriptionStatus', 'topicDefaultSubscriptionStatus', 'AttributesData', 'UTF-8', 'base64として復号しない', '存在しない場合だけ']) assert.ok(operations.includes(term), term);
});

test('12.3 WAF除外はPOSTの取込と受入証跡の64KiB超だけ', () => {
  for (const name of ['Common', 'KnownBadInputs']) {
    const rule = edge.split(`        - Name: ${name}\n`)[1].split('\n        - Name: ')[0];
    assert.match(rule, /ScopeDownStatement:\n\s+NotStatement:\n\s+Statement:\n\s+AndStatement:\n\s+Statements:/);
    assert.equal((rule.match(/ByteMatchStatement:/g) ?? []).length, 4);
    const method = /FieldToMatch: \{Method: \{\}\}\n\s+PositionalConstraint: EXACTLY\n\s+SearchString: (\S+)/.exec(rule)?.[1];
    const path = /FieldToMatch: \{UriPath: \{\}\}\n\s+PositionalConstraint: EXACTLY\n\s+SearchString: (\S+)/.exec(rule)?.[1];
    const size = Number(/ComparisonOperator: GT\n\s+Size: (\d+)/.exec(rule)?.[1]);
    const prefix = /PositionalConstraint: STARTS_WITH\n\s+SearchString: (\S+)/.exec(rule)?.[1];
    const suffix = /PositionalConstraint: ENDS_WITH\n\s+SearchString: (\S+)/.exec(rule)?.[1];
    assert.equal(prefix, '/api/v1/settings/delivery-check/'); assert.equal(suffix, '/evidence');
    const excluded = (verb, uri, bytes) => verb === method && (uri === path || uri.startsWith(prefix) && uri.endsWith(suffix)) && bytes > size;
    assert.equal(excluded('POST', '/api/v1/imports', 65537), true);
    assert.equal(excluded('POST', '/api/v1/settings/delivery-check/01K9542S00AAAAAAAAAAAAAAAA/evidence', 1398200), true);
    for (const [verb, uri, bytes] of [
      ['POST', '/api/v1/imports', 65536], ['GET', '/api/v1/imports', 65537], ['PUT', '/api/v1/imports', 65537],
      ['POST', '/api/v1/imports/id', 65537], ['POST', '/api/v1/imports/', 65537], ['POST', '/api/v1/campaigns', 100000], ['POST', '/', 100000],
      ['POST', '/api/v1/settings/delivery-check/id/submit', 100000], ['PUT', '/api/v1/settings/delivery-check/id/evidence', 100000],
      ['POST', '/api/v1/settings/delivery-check/id/evidence', 65536], ['POST', '/api/v1/settings/delivery-check/id/evidence/', 100000],
    ]) assert.equal(excluded(verb, uri, bytes), false, `${name} ${verb} ${uri} ${bytes}`);
  }
});

test('第8段階13 SESが改行済みのFirehoseレコードに区切りを付け足さない', () => {
  assert.doesNotMatch(resources.EventStream, /AppendDelimiterToRecord|ProcessingConfiguration/);
});

test('第8段階14 Cognitoの境界とトピック表示名・説明の長さを制約', () => {
  const params = blocks(main, 'Parameters');
  const pattern = new RegExp(/AllowedPattern: '([^']+)'/.exec(params.CognitoDomainPrefix)[1]);
  for (const value of ['a', 'ht2-test', 'a'.repeat(63)]) assert.equal(pattern.test(value), true, value);
  for (const value of ['', '-a', 'a-', 'UPPER', 'a_b', 'a'.repeat(64)]) assert.equal(pattern.test(value), false, value);
  for (const n of [1, 2]) {
    assert.match(params[`Topic${n}Display`], /MaxLength: 128/);
    assert.match(params[`Topic${n}Description`], /MaxLength: 500/);
  }
});

test('第8段階12・16 workerの削除権限とAPIの再確認起動権限を同環境に限定', () => {
  assert.match(resources.WorkerPolicy, /Action: \['ses:GetContact', 'ses:DeleteContact'\]\n\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:ses:\$\{AWS::Region\}:\$\{AWS::AccountId\}:contact-list\/ht2'/);
  assert.match(resources.ApiPolicy, /Action: \['lambda:InvokeFunction'\]\n\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:ht2-\$\{Env\}-worker'/);
  for (const n of [12, 13]) {
    assert.match(resources.PausedBySystemAlarm, new RegExp(`A${n}: !Ref SystemPauseReason${n}Alarm`));
    assert.match(resources[`SystemPauseReason${n}Alarm`], /MetricName: Paused/);
  }
});

test('第8段階6 smokeはsdk-checkを同期実行し失敗・不明な応答では停止', () => {
  const passed = runScript('smoke.sh', ['dev'], { MOCK_CRLF: '1', MOCK_SDK_RESULT: '{"ok":true,"packages":[{"package":"@aws-sdk/client-sesv2","ok":true}]}' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.calls, /lambda invoke .*--invocation-type RequestResponse .*--payload \{"mode":"sdk-check"\}/);
  for (const env of [{ MOCK_SDK_RESULT: '{"ok":false,"packages":[{"ok":false}]}' }, { MOCK_FUNCTION_ERROR: 'Unhandled' }, { MOCK_SDK_RESULT: '{"errorType":"Error"}' }]) {
    const result = runScript('smoke.sh', ['dev'], env);
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /cloudfront get-distribution/);
    assert.equal((result.calls.match(/lambda invoke/g) ?? []).length, 1);
  }
});

test('第8段階9 復元もSES JSON Linesで取込み、サンドボックスと取得障害では止まる', () => {
  const args = ['dev', 'import', 'package.json', 'delivery-checks/review.json'];
  const passed = runScript('restore-contacts.sh', args, {}, 'restore 111111111111 dev\n');
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.calls, /imports\/ready\/restore-\d+\.jsonl .*--content-type application\/x-ndjson/);
  assert.match(passed.calls, /"DataFormat":"JSON"/);
  assert.doesNotMatch(passed.calls, /"DataFormat":"CSV"/);
  for (const env of [{ MOCK_PRODUCTION: 'False' }, { MOCK_ACCOUNT_ERROR: '1' }]) {
    const result = runScript('restore-contacts.sh', args, env, 'restore 111111111111 dev\n');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /s3 cp|create-import-job/);
  }
});

function runEnvironment(code) {
  const result = spawnSync(bash, ['-c', code], { cwd: root, encoding: 'utf8', env: { ...process.env, HT2_ACCOUNT_ID: '111111111111' } });
  assert.ifError(result.error);
  return result;
}

test('第8段階17 env.shをsourceしてもシェルのオプション・作業場所を変更しない', () => {
  const result = runEnvironment(`before_options=$-; before_dir=$PWD; before_pipe=$(set -o | while read -r key value; do [[ $key != pipefail ]] || printf '%s' "$value"; done)
source scripts/env.sh
[[ $before_options == "$-" && $before_dir == "$PWD" ]] || exit 51
after_pipe=$(set -o | while read -r key value; do [[ $key != pipefail ]] || printf '%s' "$value"; done)
[[ $before_pipe == "$after_pipe" && $AWS_PAGER == '' && $AWS_MAX_ATTEMPTS == 1 && $AWS_CLI_FILE_ENCODING == UTF-8 ]] || exit 52
aws() { printf '111111111111\\r\\n'; }
init_env dev || exit 53
[[ $ENV == dev && $STACK == ht2-main-dev ]] || exit 54
printf survived`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'survived');
});

for (const [name, code, expected] of [
  ['不正環境', 'init_env unknown', 1],
  ['アカウント不一致', 'aws() { printf "222222222222\\n"; }; init_env dev', 1],
  ['アカウント取得失敗', 'aws() { return 57; }; init_env dev', 57],
  ['出力の欠落', 'aws() { printf "None\\n"; }; output Missing ht2-main-dev', 1],
  ['出力取得失敗', 'aws() { return 58; }; output Missing ht2-main-dev', 58],
  ['未初期化', 'output Missing', 1],
]) test(`第8段階17 ${name}はreturnで返し端末を終了しない`, () => {
  const result = runEnvironment(`source scripts/env.sh\n${code}\nstatus=$?\nprintf 'survived:%s' "$status"`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `survived:${expected}`);
});
