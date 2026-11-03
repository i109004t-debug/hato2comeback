import { createAwsAdapters, checkAwsSdk } from '../common/aws.js';
import { createConfig } from '../common/config.js';
import { createDdb } from '../common/ddb.js';
import { createSendLock } from '../common/lock.js';
import { createPrecheck } from '../common/precheck.js';
import { createSecrets } from '../common/secrets.js';
import { createSesv2 } from '../common/sesv2.js';
import { createMetrics } from '../common/metrics.js';
import { createAudit } from '../common/audit.js';
import { createLogger } from '../common/log.js';
import { createTime } from '../common/time.js';
import { AppError, invalid } from '../common/http.js';
import { prepare } from './modes/prepare.js';
import { send } from './modes/send.js';
import { finish } from './modes/finish.js';
import { importContacts } from './modes/import.js';
import { daily, authentication } from './modes/daily.js';
import { backfillContacts } from './modes/contact-backfill.js';
import { createContactLock } from '../common/contact-lock.js';

export function createHandler(deps = {}) {
  const environment = deps.environment ?? process.env;
  const base = {
    env: environment.ENV, tableName: environment.TABLE_NAME, dataBucket: environment.DATA_BUCKET,
    contactList: environment.CONTACT_LIST, configSet: environment.CONFIG_SET,
    senderDomain: environment.SENDER_DOMAIN, region: environment.AWS_REGION ?? 'ap-northeast-1',
    eventStreamArn: environment.EVENT_STREAM_ARN, alertTopicArn: environment.ALERT_TOPIC_ARN,
    stateMachineArn: environment.STATE_MACHINE_ARN, scheduleGroup: environment.SCHEDULE_GROUP,
    ...createTime(deps), ...deps,
  };
  let runtime;
  const initialize = (context) => {
    if (runtime) return runtime;
    const aws = createAwsAdapters({ region: base.region });
    runtime = { ...aws, ...base };
    runtime.accountId ??= context.invokedFunctionArn?.split(':')[4];
    runtime.store ??= createDdb(runtime);
    runtime.metrics ??= createMetrics(runtime);
    runtime.config ??= createConfig(runtime);
    runtime.secrets = deps.secretsProvider ?? createSecrets(runtime);
    runtime.audit ??= createAudit(runtime);
    runtime.record ??= (id, action, code) => runtime.audit.write({ actor_sub: 'SYSTEM', action, target: id, result: code, request_id: 'worker' });
    runtime.notify ??= async (code, id) => {
      if (!runtime.alertTopicArn) throw new AppError('MONITORING_UNAVAILABLE', 503, '通知先が設定されていません。');
      await runtime.sns.publish({ TopicArn: runtime.alertTopicArn, Message: JSON.stringify({ campaign_id: id, code }) });
    };
    runtime.ses = deps.sesControl ?? createSesv2(runtime);
    runtime.lock ??= createSendLock(runtime);
    runtime.contactLock ??= createContactLock(runtime);
    runtime.precheck ??= createPrecheck(runtime);
    return runtime;
  };
  return async (event, context = {}) => {
    const logger = deps.logger ?? createLogger({ fn: 'worker', req_id: context.awsRequestId, now: base.now });
    try {
      if (!event || !['prepare', 'send', 'finish', 'import', 'daily', 'contact-backfill', 'sdk-check', 'auth-check'].includes(event.mode)) throw invalid('mode');
      if (event.mode === 'sdk-check') return await checkAwsSdk({ load: deps.sdkLoad, loadVersion: deps.sdkVersionLoad });
      if (event.mode === 'auth-check') return await authentication(initialize(context));
      if (event.mode === 'contact-backfill') return await backfillContacts(event, initialize(context), context);
      if (event.mode === 'daily') return await daily(event, initialize(context), context);
      if (event.mode === 'import') {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(event.import_id ?? '')) throw invalid('import_id');
        return await importContacts(event, initialize(context), context);
      }
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(event.campaign_id ?? '') || typeof event.execution_arn !== 'string' || !event.execution_arn.startsWith('arn:aws:states:') || event.execution_arn.includes('@')) throw invalid('execution');
      const services = initialize(context);
      if (event.mode === 'prepare') return await prepare(event, services, context);
      if (event.mode === 'send') return await send(event, services, context);
      return await finish(event, services, context);
    } catch (error) {
      logger.error('Worker failed', { err: error });
      if (error instanceof AppError) throw error;
      // SES等のエラー本文をStep FunctionsのCauseへ流さない。
      throw new AppError('INTERNAL', 500, '送信処理中にエラーが発生しました。');
    }
  };
}

export const handler = createHandler();
