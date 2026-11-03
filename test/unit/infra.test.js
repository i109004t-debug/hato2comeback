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

test('12.1 主スタックとエッジに全必須リソースがある', () => {
  const expected = {
    WebBucket: 'S3::Bucket', DataBucket: 'S3::Bucket', EventLogBucket: 'S3::Bucket', Distribution: 'CloudFront::Distribution',
    UserPool: 'Cognito::UserPool', HttpApi: 'ApiGatewayV2::Api', ApiFunction: 'Lambda::Function', WorkerFunction: 'Lambda::Function',
    BroadcastStateMachine: 'StepFunctions::StateMachine', Table: 'DynamoDB::Table', EmailIdentity: 'SES::EmailIdentity',
    ConfigurationSet: 'SES::ConfigurationSet', ContactList: 'SES::ContactList', EventStream: 'KinesisFirehose::DeliveryStream',
    EventsDatabase: 'Glue::Database', EventsTable: 'Glue::Table', AthenaWorkGroup: 'Athena::WorkGroup',
    ScheduleGroup: 'Scheduler::ScheduleGroup', DailySchedule: 'Scheduler::Schedule', ConfigParameter: 'SSM::Parameter',
    OriginSecret: 'SecretsManager::Secret', EraseSecret: 'SecretsManager::Secret', AlertTopic: 'SNS::Topic', AppRecord: 'Route53::RecordSet',
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
  assert.match(resources.ContactList, /DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain/);
  assert.equal((resources.ContactList.match(/DefaultSubscriptionStatus: OPT_OUT/g) ?? []).length, 2);
  for (const name of ['CloudWatchDestination', 'FirehoseDestination']) {
    assert.match(resources[name], /Enabled: true/);
    const events = /MatchingEventTypes: \[([^\]]+)\]/.exec(resources[name])[1].split(',').map((s) => s.trim().replace('deliveryDelay', 'DELIVERY_DELAY').replace('renderingFailure', 'RENDERING_FAILURE').toUpperCase());
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
  assert.match(resources.DataBucketPolicy, /aws:SourceArn/);
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
  assert.match(resources.SesFirehoseRole, /configuration-set\/postline-\$\{Env\}/);
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
  ses: 'GetAccount GetEmailIdentity GetConfigurationSet GetConfigurationSetEventDestinations GetContactList ListContacts GetContact CreateContact UpdateContact DeleteContact GetSuppressedDestination GetImportJob CreateEmailTemplate GetEmailTemplate TestRenderEmailTemplate SendEmail',
  ddb: 'GetItem PutItem UpdateItem Query TransactWriteItems', s3: 'PutObject GetObject HeadObject',
  sfn: 'StartExecution DescribeExecution SendTaskSuccess SendTaskFailure', scheduler: 'CreateSchedule DeleteSchedule GetSchedule',
  cognito: 'AdminGetUser AdminListGroupsForUser', cloudwatch: 'GetMetricData DescribeAlarms', ssm: 'GetParameter', secrets: 'GetSecretValue', lambda: 'Invoke',
};
const workerOperations = {
  ses: 'GetAccount GetEmailIdentity GetConfigurationSet GetConfigurationSetEventDestinations GetContactList ListContacts SendEmail CreateImportJob GetImportJob DeleteEmailTemplate',
  ddb: 'GetItem PutItem UpdateItem Query BatchGetItem', s3: 'PutObject GetObject HeadObject', cloudwatch: 'GetMetricData DescribeAlarms', sns: 'Publish', ssm: 'GetParameter', secrets: 'GetSecretValue',
};
const prefixes = {ses:'ses',ddb:'dynamodb',s3:'s3',sfn:'states',scheduler:'scheduler',cognito:'cognito-idp',cloudwatch:'cloudwatch',sns:'sns',ssm:'ssm',secrets:'secretsmanager',lambda:'lambda'};
const iamOperation = (service, operation) => service === 's3' && operation === 'HeadObject' ? 'GetObject' : service === 'lambda' && operation === 'Invoke' ? 'InvokeFunction' : service === 'ddb' && operation === 'TransactWriteItems' ? 'PutItem' : operation;

for (const [name, operations] of [['Api',apiOperations],['Worker',workerOperations]]) {
  test(`12.6 ${name} IAMの許可操作を設計表とaws.jsの全操作へ照合（過不足なし）`, () => {
    const expected = new Set(['logs:CreateLogStream','logs:PutLogEvents', ...(name === 'Api' ? ['iam:PassRole'] : [])]);
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

test('12.6 共通拒否・固定テンプレート・監査ログの拒否とSendEmailのリソース制限', () => {
  for (const name of ['ApiPolicy','WorkerPolicy']) {
    const p = resources[name];
    assert.match(p, /Sid: DenyDestructiveSes\n\s+Effect: Deny/);
    for (const action of ['DeleteContactList','UpdateContactList','DeleteEmailIdentity','DeleteSuppressedDestination','PutAccount*']) assert.ok(p.includes(`'ses:${action}'`), action);
    assert.match(p, /Sid: DenyAuditMutation\n\s+Effect: Deny/);
    assert.match(p, /ForAnyValue:StringLike.*dynamodb:LeadingKeys.*AUDIT#\*/);
    assert.match(p, /Sid: DenyFixedTemplateMutation\n\s+Effect: Deny/);
    assert.match(p, /Action: \['ses:SendEmail'\]\n\s+Resource: \[!Sub '.*identity\/\$\{SenderDomain\}'.*configuration-set\/postline-\$\{Env\}.*contact-list\/postline.*template\/pl-c-\*/);
    assert.match(p, /ses:FromAddress/);
  }
  assert.match(resources.ApiPolicy, /Action: \['ses:UpdateEmailTemplate', 'ses:DeleteEmailTemplate'\]/);
  assert.match(resources.WorkerPolicy, /Action: \['ses:DeleteEmailTemplate'\]\n\s+Resource:.*template\/pl-c-\*/);
  assert.doesNotMatch(resources.ApiPolicy + resources.WorkerPolicy, /s3:ListBucket/);
});

test('12.6 引継ぎの限定S3読取・PassRole・通知と環境変数を実装に照合', () => {
  for (const prefix of ['results/*','delivery-checks/*','imports/report/*','recipients/*']) assert.ok(resources.ApiPolicy.includes(`\${DataBucket.Arn}/${prefix}`));
  assert.match(resources.WorkerPolicy, /Action: \['s3:GetObject'\]\n\s+Resource:.*delivery-checks\/\*/);
  assert.doesNotMatch(/Action: \['s3:PutObject'\]\n\s+Resource:([^\n]+)/.exec(resources.WorkerPolicy)[1], /delivery-checks/);
  assert.match(resources.ApiPolicy, /iam:PassedToService.*scheduler.amazonaws.com/);
  assert.match(resources.WorkerPolicy, /sns:Publish/);
  const sources = readdirSync(new URL('../../src/', import.meta.url), {recursive:true}).filter((n) => n.endsWith('.js')).map((n) => read(`src/${n.replaceAll('\\','/')}`)).join('\n');
  const envs = new Set([...sources.matchAll(/environment\.([A-Z][A-Z_]+)/g)].map((m) => m[1]));
  for (const name of ['CONFIG_PARAM','ORIGIN_SECRET_ARN','ERASE_SECRET_ARN','LOG_LEVEL']) envs.add(name);
  for (const fn of ['ApiFunction','WorkerFunction']) for (const name of envs) {
    if (name !== 'AWS_REGION') assert.ok(resources[fn].includes(`          ${name}:`), `${fn}.${name}`);
  }
  for (const fn of ['ApiFunction','WorkerFunction']) {
    assert.match(resources[fn], /Runtime: nodejs24.x/);
    assert.match(resources[fn], /Architectures: \[arm64\]/);
    assert.doesNotMatch(resources[fn], /VpcConfig/);
  }
  assert.match(resources.WorkerFunction, /ReservedConcurrentExecutions: 3/);
});

test('12.7 初期設定は送信無効、SSMの全設定キーを実装の検証器で検査', () => {
  const source = /\{"sending_enabled":.+\}/.exec(resources.ConfigParameter)[0];
  for (const env of ['dev','stg','prod']) {
    const settings = JSON.parse(source.replaceAll('${Env}',env).replace('${IsProduction}',String(env === 'prod')));
    assert.deepEqual(Object.keys(settings).sort(), Object.keys(configDefaults(env)).sort());
    validateConfig(settings,env);
    assert.equal(settings.sending_enabled,false);
    assert.equal(settings.delivery_check_required,env === 'prod');
  }
  assert.match(resources.EraseSecret, /DeletionPolicy: Retain/);
  assert.match(blocks(main,'Parameters').EraseHmacKey, /NoEcho: true/);
});

test('12.8 環境別アカウント例・リージョン固定・全パラメータの定義一致', () => {
  const params = blocks(main,'Parameters');
  const accounts = new Set();
  for (const env of ['dev','stg','prod']) {
    const entries = JSON.parse(read(`infra/params/${env}.json`));
    assert.deepEqual(entries.map((p) => p.ParameterKey).sort(), Object.keys(params).sort());
    const values = Object.fromEntries(entries.map((p) => [p.ParameterKey,p.ParameterValue]));
    assert.equal(values.Env,env);
    assert.equal(values.Topic1Display,'会報');
    assert.equal(values.Topic2Display,'イベント・チケット情報');
    assert.ok(values.AppDomain.includes('example') && values.SenderDomain.includes('example'));
    assert.equal(Buffer.from(values.EraseHmacKey,'base64').length,32);
    accounts.add(values.ExpectedAccountId);
  }
  assert.equal(accounts.size,3);
  assert.match(main, /!Ref 'AWS::Region', ap-northeast-1/);
  assert.match(edge, /!Ref 'AWS::Region', us-east-1/);
  assert.match(main, /!Ref 'AWS::AccountId', !Ref ExpectedAccountId/);
});

test('13.3 アラームの物理名・しきい値・missingとUSER以外の停止通知', () => {
  for (const suffix of ['ses-bounce-rate','ses-complaint-rate','needs-review','unknown-results','paused-by-system','sfn-failed','api-lambda-errors','worker-lambda-errors','ses-busy','firehose-delivery','firehose-freshness','rendering-or-reject','api-5xx']) assert.ok(main.includes(`postline-\${Env}-${suffix}'`), suffix);
  for (const name of ['SesBounceRateAlarm','SesComplaintRateAlarm','FirehoseDeliveryAlarm','FirehoseFreshnessAlarm']) assert.match(resources[name], /TreatMissingData: missing/);
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
    env:{...process.env,POSTLINE_ACCOUNT_ID:'111111111111',ARTIFACT_BUCKET:'example-artifacts',MOCK_CALLS:'build/infra-mock-calls.txt',...env},
  });
  assert.ifError(result.error);
  return {...result,calls:readFileSync(callsPath,'utf8')};
}

test('15.3 全スクリプトはstrict bashで、AWS CLI以外の実行環境・外部パッケージ不要', () => {
  for (const name of scripts) {
    const source=read(`scripts/${name}`);
    assert.ok(source.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n'),name);
    assert.doesNotMatch(source, /(?:^|[;|&]|\$\()\s*(?:npm|npx|jq|python3?|node|curl|zip|sam|terraform|cdk)\s/m);
    const result=spawnSync(bash,['-n',`scripts/${name}`],{cwd:root,encoding:'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status,0,`${name}: ${result.stderr}`);
  }
});

test('15.3 bashパッケージのZIPを全ファイル・バイト列・CRC32・中央ディレクトリまで確認', () => {
  const result=spawnSync(bash,['scripts/package.sh'],{cwd:root,encoding:'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
  const zip=readFileSync(new URL('build/backend.zip',root));
  let offset=0; const entries=[];
  while(zip.readUInt32LE(offset) === 0x04034b50) {
    const size=zip.readUInt32LE(offset+18), length=zip.readUInt16LE(offset+26);
    const name=zip.subarray(offset+30,offset+30+length).toString();
    const body=zip.subarray(offset+30+length,offset+30+length+size);
    assert.deepEqual(body,readFileSync(new URL(name,root)),name);
    let crc=0xffffffff;
    for(const byte of body) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    assert.equal(zip.readUInt32LE(offset+14),(crc^0xffffffff)>>>0,name);
    entries.push({name,offset}); offset+=30+length+size;
  }
  const central=offset;
  for(const entry of entries) {
    assert.equal(zip.readUInt32LE(offset),0x02014b50);
    assert.equal(zip.readUInt32LE(offset+42),entry.offset);
    const length=zip.readUInt16LE(offset+28);
    assert.equal(zip.subarray(offset+46,offset+46+length).toString(),entry.name);
    offset+=46+length;
  }
  assert.equal(zip.readUInt32LE(offset),0x06054b50);
  assert.equal(zip.readUInt32LE(offset+16),central);
  assert.equal(zip.readUInt16LE(offset+10),entries.length);
  const expected=['package.json',...readdirSync(new URL('src/',root),{recursive:true}).filter((n)=>n.endsWith('.js')).map((n)=>`src/${n.replaceAll('\\','/')}`)].sort();
  assert.deepEqual(entries.map((e)=>e.name).sort(),expected);
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
    const r=runScript('deploy.sh',['dev',action,'example-review'],env,'execute postline-main-dev example-review\n');
    assert.notEqual(r.status,0,`${action} ${JSON.stringify(env)}`);
    assert.doesNotMatch(r.calls,/execute-change-set/);
  }
});

test('15.3 レビュー済みの明示的executeだけが変更セットを実行する', () => {
  const r=runScript('deploy.sh',['dev','execute','example-review'],{},'execute postline-main-dev example-review\n');
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
  assert.doesNotMatch(result.calls,/OPT_IN|--no-unsubscribe-all|delete-suppressed/);
});

test('18.2 技術資料は全U-xxを実機確認として残す', () => {
  const text=read('docs/構築手順書.md');
  for(let i=1;i<=10;i++) assert.ok(text.includes(`U-${String(i).padStart(2,'0')}`));
  assert.match(text,/実機で確認/);
  assert.match(read('docs/運用手順書.md'),/実機で確認/);
});
