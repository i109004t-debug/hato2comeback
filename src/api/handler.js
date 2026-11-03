import { createAwsAdapters } from '../common/aws.js';
import { createConfig } from '../common/config.js';
import { createDdb } from '../common/ddb.js';
import { createSendLock } from '../common/lock.js';
import { createContactLock } from '../common/contact-lock.js';
import { createPrecheck } from '../common/precheck.js';
import { createSecrets } from '../common/secrets.js';
import { createSesv2 } from '../common/sesv2.js';
import { createAudit } from '../common/audit.js';
import { createLogger } from '../common/log.js';
import { createTime } from '../common/time.js';
import { createMetrics } from '../common/metrics.js';
import { apiSchemaStore } from '../common/schema.js';
import { createAuthz, authorize } from '../common/authz.js';
import { accessClaims, assertOrigin, assertRequestUrl, errorResponse, jsonResponse, parseJsonBody } from '../common/http.js';
import { resolveRoute } from '../common/router.js';
import { validateRoute, validateParams, validateQuery } from '../common/validate.js';
import { validateImportRequest } from '../common/csv.js';
import me from './routes/me.js';
import settings from './routes/settings.js';
import topics from './routes/topics.js';
import contacts from './routes/contacts.js';
import imports from './routes/imports.js';
import campaigns from './routes/campaigns.js';
import auditRoutes from './routes/audit.js';

const routes = { ...me, ...settings, ...topics, ...contacts, ...imports, ...campaigns, ...auditRoutes };
const topicOperations = new Set(['contacts.list', 'contacts.create', 'contacts.update', 'contacts.unsubscribe', 'contacts.reconsent', 'campaigns.create', 'campaigns.update']);

export function createHandler(deps = {}) {
  const environment = deps.environment ?? process.env;
  const base = {
    env: environment.ENV, tableName: environment.TABLE_NAME, dataBucket: environment.DATA_BUCKET,
    contactList: environment.CONTACT_LIST, configSet: environment.CONFIG_SET, senderDomain: environment.SENDER_DOMAIN,
    region: environment.AWS_REGION ?? 'ap-northeast-1', eventStreamArn: environment.EVENT_STREAM_ARN,
    clientId: environment.WEB_CLIENT_ID, userPoolId: environment.USER_POOL_ID,
    stateMachineArn: environment.STATE_MACHINE_ARN, scheduleGroup: environment.SCHEDULE_GROUP,
    schedulerRoleArn: environment.SCHEDULER_ROLE_ARN, workerFunctionArn: environment.WORKER_FUNCTION_ARN,
    eraseMacKeyId: environment.ERASE_MAC_KEY_ID,
    alertTopicArn: environment.ALERT_TOPIC_ARN,
    ...createTime(deps), ...deps,
  };
  let runtime;
  const initialize = (context) => {
    if (runtime) return runtime;
    runtime = { ...createAwsAdapters({ region: base.region }), ...base, statsCache: new Map() };
    runtime.accountId ??= context.invokedFunctionArn?.split(':')[4];
    runtime.store = apiSchemaStore(runtime.store ?? createDdb(runtime));
    runtime.metrics ??= createMetrics(runtime);
    runtime.config ??= createConfig(runtime);
    runtime.secrets = deps.secretsProvider ?? createSecrets(runtime);
    runtime.authz ??= createAuthz(runtime);
    runtime.ses = deps.sesControl ?? createSesv2(runtime);
    runtime.lock ??= createSendLock(runtime);
    runtime.contactLock ??= createContactLock(runtime);
    runtime.precheck ??= createPrecheck(runtime);
    runtime.notify ??= async (code, id) => runtime.sns.publish({ TopicArn: runtime.alertTopicArn, Message: JSON.stringify({ campaign_id: id, code }) });
    return runtime;
  };
  return async (event, context = {}) => {
    const started = base.now();
    const requestId = context.awsRequestId ?? event?.requestContext?.requestId ?? 'api';
    const logger = deps.logger ?? createLogger({ fn: 'api', req_id: requestId, now: base.now });
    let audit;
    let route;
    try {
      const services = initialize(context);
      assertOrigin(event, await services.secrets.get('origin-verify'));
      const claims = accessClaims(event, services.clientId);
      route = resolveRoute(event.requestContext?.http?.method, event.rawPath);
      const user = await services.authz.resolveUser(claims.sub);
      authorize(user, route.operation, { pause_reason: 'USER' });
      const secret = await services.secrets.get('address-hmac');
      services.addressSecret = secret;
      services.hmacKey = secret.key;
      const auditService = deps.audit ?? createAudit({ ...services, hmacKey: services.hmacKey });
      services.audit = auditService;
      audit = (action, target, details, email, result = 'SUCCESS') => auditService.write({ actor_sub: user.sub, action, target, result, request_id: requestId, ...(details ? { details } : {}), ...(email ? { email } : {}) });
      assertRequestUrl(event);
      const params = validateParams(route.params);
      const query = validateQuery(route.operation, event.queryStringParameters ?? Object.fromEntries(new URLSearchParams(event.rawQueryString ?? '')));
      const input = route.operation === 'imports.create' ? validateImportRequest(event) : parseJsonBody(event);
      let body = route.operation === 'imports.create' ? input : validateRoute(route.operation, input, { now: services.now, senderDomain: services.senderDomain });
      let topicDefinitions = [];
      if (topicOperations.has(route.operation)) topicDefinitions = (await services.ses.getContactList({ ContactListName: services.contactList })).Topics ?? [];
      const topics = topicDefinitions.map((item) => item.TopicName);
      if (topicOperations.has(route.operation)) body = validateRoute(route.operation, input, { now: services.now, senderDomain: services.senderDomain, topics });
      const value = await routes[route.operation]({ runtime: services, event, context, route, params, query, body, user, audit, requestId, topics, topicDefinitions });
      if (!['GET'].includes(route.method) && !['contacts.get', 'campaigns.preview', 'campaigns.submit', 'campaigns.approve', 'campaigns.unknowns'].includes(route.operation)) await audit(route.operation.toUpperCase().replaceAll('.', '_'), params.id ?? params.importId ?? route.operation.split('.')[0]);
      return jsonResponse(value?.statusCode ?? 200, value?.data ?? value);
    } catch (error) {
      if (audit && route?.method !== 'GET') {
        try { await audit('API_REJECTED', route.id, { code: error.code ?? 'INTERNAL' }, undefined, 'FAIL'); } catch (auditError) { logger.error('Audit failed', { err: auditError }); }
      }
      const response = errorResponse(error, requestId, logger);
      runtime?.metrics?.emit(response.statusCode >= 500 ? 'ApiError5xx' : 'ApiError4xx', 1, { Route: route?.id ?? '$default' });
      return response;
    } finally {
      runtime?.metrics?.emit('ApiLatencyMs', Math.max(0, base.now() - started), { Route: route?.id ?? '$default' });
    }
  };
}

export const handler = createHandler();
