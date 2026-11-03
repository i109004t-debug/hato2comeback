import { fixture, failure, ID } from './sending.js';
import { createHandler } from '../../src/api/handler.js';
import { createHandler as createWorker } from '../../src/worker/handler.js';

export function managementFixture(options = {}) {
  const f = fixture(options);
  f.role = options.role ?? 'admin';
  f.enabled = true;
  f.sub = 'user';
  f.cognitoCalls = 0;
  f.changes = [];
  f.templates = new Map();
  f.executions = new Map();
  f.schedules = new Map();
  f.jobs = new Map();
  f.invocations = [];
  f.tokens = [];
  f.topics = [{ TopicName: 'news', DisplayName: '会報', DefaultSubscriptionStatus: 'OPT_OUT' }, { TopicName: 'event', DisplayName: 'イベント', DefaultSubscriptionStatus: 'OPT_OUT' }];
  const originalGet = f.deps.ses.getContact;
  Object.assign(f.deps.ses, {
    getContactList: async () => ({ Topics: f.topics }),
    getContact: async (input) => structuredClone(await originalGet(input)),
    getSuppressedDestination: async () => { throw failure('NotFoundException', 404); },
    createContact: async (input) => { f.changes.push(input); if (f.contacts.some((item) => item.EmailAddress === input.EmailAddress)) throw failure('AlreadyExistsException', 409); f.contacts.push(structuredClone(input)); return {}; },
    updateContact: async (input) => { f.changes.push(structuredClone(input)); const index = f.contacts.findIndex((item) => item.EmailAddress === input.EmailAddress); f.contacts[index] = structuredClone(input); return {}; },
    deleteContact: async (input) => { f.changes.push(input); f.contacts = f.contacts.filter((item) => item.EmailAddress !== input.EmailAddress); return {}; },
    createEmailTemplate: async (input) => { if (f.templates.has(input.TemplateName)) throw failure('AlreadyExistsException', 409); f.templates.set(input.TemplateName, structuredClone(input.TemplateContent)); return {}; },
    getEmailTemplate: async (input) => ({ TemplateContent: structuredClone(f.templates.get(input.TemplateName)) }),
    testRenderEmailTemplate: async (input) => ({ RenderedTemplate: `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(f.templates.get(input.TemplateName).Text).toString('base64')}` }),
    deleteEmailTemplate: async (input) => { f.templates.delete(input.TemplateName); return {}; },
    createImportJob: async (input) => { const JobId = `job${f.jobs.size + 1}`; f.jobs.set(JobId, { input, JobStatus: 'PROCESSING', ProcessedRecordsCount: 1, FailedRecordsCount: 0 }); return { JobId }; },
    getImportJob: async (input) => structuredClone(f.jobs.get(input.JobId)),
  });
  Object.assign(f.deps, {
    clientId: 'web', userPoolId: 'pool', stateMachineArn: 'arn:aws:states:ap-northeast-1:123456789012:stateMachine:ht2', scheduleGroup: 'ht2-stg', schedulerRoleArn: 'arn:aws:iam::123456789012:role/scheduler', workerFunctionArn: 'worker',
    secretsProvider: { get: async (name) => name === 'origin-verify' ? { current: 'origin', previous: 'old-origin' } : { kid: 'k1', key: '7'.repeat(64) } },
    cognito: {
      adminGetUser: async () => { f.cognitoCalls += 1; return { Enabled: f.enabled, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: f.sub }, { Name: 'name', Value: '運営者' }] }; },
      adminListGroupsForUser: async () => ({ Groups: (Array.isArray(f.role) ? f.role : [f.role]).map((GroupName) => ({ GroupName })) }),
    },
    sfn: {
      startExecution: async (input) => { if (f.executions.has(input.name)) throw failure('ExecutionAlreadyExists', 400); f.executions.set(input.name, input); return { executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ht2:' + input.name }; },
      describeExecution: async (input) => {
        const execution = f.executions.get(input.executionArn.split(':').at(-1));
        if (!execution) throw failure('ExecutionDoesNotExist', 400);
        return { executionArn: input.executionArn, status: 'RUNNING', input: execution.input };
      },
      sendTaskSuccess: async (input) => { f.tokens.push({ success: input }); return {}; },
      sendTaskFailure: async (input) => { f.tokens.push({ failure: input }); return {}; },
    },
    scheduler: {
      createSchedule: async (input) => { if (f.schedules.has(input.Name)) throw failure('ConflictException', 409); f.schedules.set(input.Name, input); return {}; },
      getSchedule: async (input) => {
        if (!f.schedules.has(input.Name)) throw failure('ResourceNotFoundException', 404);
        return structuredClone(f.schedules.get(input.Name));
      },
      deleteSchedule: async (input) => { if (!f.schedules.has(input.Name)) throw failure('ResourceNotFoundException', 404); f.schedules.delete(input.Name); return {}; },
    },
    lambda: { invoke: async (input) => { f.invocations.push(input); return { StatusCode: 202 }; } },
    dns: {
      resolveTxt: async (name) => [[name.startsWith('_dmarc.') ? 'v=DMARC1; p=none; adkim=s; aspf=r' : 'v=spf1 include:amazonses.com ~all']],
      resolveMx: async (name) => name.startsWith('bounce.') ? [{ priority: 10, exchange: 'feedback-smtp.ap-northeast-1.amazonses.com.' }] : [],
      resolve4: async () => ['192.0.2.10'],
      resolveCname: async (name) => [`${name.split('.')[0]}.dkim.amazonses.com.`],
    },
  });
  f.identity.DkimAttributes.Tokens = ['one', 'two', 'three'];
  f.identity.DkimAttributes.SigningHostedZone = 'dkim.amazonses.com';
  f.resetApi = () => { f.api = createHandler(f.deps); };
  f.resetWorker = () => { f.worker = createWorker(f.deps); };
  f.resetApi(); f.resetWorker();
  f.request = async (operation, body, extra = {}) => {
    const [method, path] = operation.split(' ');
    const event = {
      headers: { 'x-origin-verify': 'origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      rawPath: '/api/v1' + path, requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: f.sub, token_use: 'access', client_id: 'web' } } } },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
    };
    const response = await f.api(event, f.context);
    return { ...response, json: JSON.parse(response.body) };
  };
  f.campaignPath = `/campaigns/${ID}`;
  f.draft = (set = {}) => f.setCampaign({ status: 'DRAFT', subject: '会報', body_text: '本文\n', topic_display: '会報', rev: 0, ...set });
  f.importCsv = (email = 'new@example.com', extra = '') => `email,name,consent_at,consent_source,topics\n${email},会員,2026-01-01T00:00:00Z,フォーム,news\n${extra}`;
  f.receive = async (csv, idem = 'once') => f.request('POST /imports', undefined, { headers: { 'x-origin-verify': 'origin', 'content-type': 'text/csv; charset=utf-8', 'idempotency-key': idem }, body: csv });
  return f;
}
