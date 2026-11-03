import { allRecords } from '../../common/records.js';
import { currentConfigHash } from '../../common/acceptance.js';
import { monitoringAlarmNames } from '../../common/monitoring.js';
import { REQUIRED_EVENTS } from '../../common/precheck.js';
import { listStaff, enabledAdmins } from '../../common/staff.js';
import { jstDate } from '../../common/time.js';

export function createReadiness(runtime) {
  let cache;
  let pending;
  const load = async () => {
    const items = [];
    const check = async (id, title, owner, action, inspect) => {
      let value;
      try { value = await inspect(); } catch { value = { status: 'UNKNOWN', detail: '状態を取得できません。担当者が確認してください。' }; }
      items.push({ id, title, owner, action, ...value });
    };
    const result = (ok, detail = '', warning = false) => ({ status: ok ? warning ? 'WARN' : 'OK' : 'BLOCKED', detail });
    let config;
    let org;
    let account;
    try { config = await runtime.config.get(); org = await runtime.store.get('SETTINGS', 'ORG'); } catch { /* 項目ごとにUNKNOWNを返す。 */ }
    const needConfig = () => { if (!config) throw new Error('Configuration unavailable'); return config; };
    await check('sending_enabled', '全体の停止スイッチ', 'AWS_ADMIN', '全体の停止理由を確かめ、送信を有効にしてください。', async () => result(needConfig().sending_enabled));
    await check('ses', 'SESの本番利用・送信の有効', 'AWS_ADMIN', 'SESの本番利用と送信制限を確認してください。', async () => {
      account = await runtime.ses.getAccount({});
      return result(account.ProductionAccessEnabled === true && account.SendingEnabled === true && account.EnforcementStatus === 'HEALTHY');
    });
    await check('authentication', '送信元の認証', 'AWS_ADMIN', 'DNSとSESの認証設定を直し、送信元を再確認してください。', async () => {
      const auth = await runtime.store.get('SETTINGS', 'AUTH_STATUS');
      const age = runtime.now() - Date.parse(auth?.checked_at);
      if (!auth || !(age >= 0 && age <= needConfig().auth_status_max_age_hours * 3600000) || auth.config_hash !== currentConfigHash(runtime, org ?? {})) return result(false);
      if (auth.status === 'UNKNOWN') return { status: 'WARN', detail: '送信元を再確認中です。送信は開始できません。' };
      return result(auth.status === 'PASS');
    });
    await check('event_destinations', 'イベント発行先3つ', 'AWS_ADMIN', 'CloudWatch・Firehose・EventBridgeの発行先を有効にしてください。', async () => {
      const entries = (await runtime.ses.getConfigurationSetEventDestinations({ ConfigurationSetName: runtime.configSet })).EventDestinations;
      if (!Array.isArray(entries)) throw new Error('Missing destinations');
      const enabled = entries.filter((item) => item.Enabled === true && REQUIRED_EVENTS.every((event) => item.MatchingEventTypes?.includes(event)));
      const cw = enabled.some((item) => item.CloudWatchDestination?.DimensionConfigurations?.length === 1 && item.CloudWatchDestination.DimensionConfigurations[0].DimensionName === 'campaign' && item.CloudWatchDestination.DimensionConfigurations[0].DimensionValueSource === 'MESSAGE_TAG' && item.CloudWatchDestination.DimensionConfigurations[0].DefaultDimensionValue === 'none');
      return result(cw && enabled.some((item) => item.KinesisFirehoseDestination?.DeliveryStreamArn === runtime.eventStreamArn) && enabled.some((item) => item.EventBridgeDestination?.EventBusArn === `arn:aws:events:${runtime.region}:${runtime.accountId}:event-bus/default`));
    });
    for (const reputation of [false, true]) await check(reputation ? 'reputation' : 'monitoring', reputation ? '評判のアラーム' : '監視のアラーム', reputation ? 'ADMIN' : 'AWS_ADMIN', reputation ? '配送記録を調べ、警報の原因を直してください。' : '必要な監視アラームを復旧してください。', async () => {
      const names = reputation ? needConfig().reputation_alarms : runtime.monitoringAlarms ?? monitoringAlarmNames(runtime.env);
      const alarms = (await runtime.cloudwatch.describeAlarms({ AlarmNames: names })).MetricAlarms;
      if (!Array.isArray(alarms)) throw new Error('Missing alarms');
      const states = names.map((name) => alarms.find((item) => item.AlarmName === name)?.StateValue);
      if (states.some((state) => !state || state === 'ALARM')) return result(false);
      if (states.some((state) => !['OK', 'INSUFFICIENT_DATA'].includes(state))) throw new Error('Unknown alarm state');
      return result(reputation || states.every((state) => state === 'OK'), '', reputation && states.includes('INSUFFICIENT_DATA'));
    });
    await check('delivery_check', '受入記録', 'ADMIN', '設定画面から受入確認を始め、試験と証跡を登録して確定してください。', async () => {
      const delivery = org?.delivery_check;
      const auth = await runtime.store.get('SETTINGS', 'AUTH_STATUS');
      const maxDays = needConfig().delivery_check_max_age_days;
      const remaining = maxDays - (runtime.now() - Date.parse(delivery?.passed_at)) / 86400000;
      const valid = delivery?.status === 'PASS' && remaining > 0 && remaining <= maxDays && delivery.config_hash === currentConfigHash(runtime, org) && delivery.dns_config_hash === auth?.dns_config_hash;
      if (!valid) return result(false);
      const keys = delivery.evidence_keys ?? (delivery.evidence_key ? [delivery.evidence_key] : []);
      if (!keys.length) return result(false);
      for (const Key of keys) await runtime.s3.headObject({ Bucket: runtime.dataBucket, Key });
      return result(true, `残り${Math.ceil(remaining)}日`, remaining <= 30);
    });
    await check('quota', '今日の残り枠とSESの24時間の残り', 'AWS_ADMIN', '枠の回復を待つか、1日の上限とSES送信枠を見直してください。', async () => {
      const config = needConfig();
      if (!account?.SendQuota) throw new Error('Quota unavailable');
      const daily = await runtime.store.get('DAILY', jstDate(runtime.now()));
      const orgLeft = config.daily_send_cap - (daily?.reserved_attempts ?? 0);
      const quota = account.SendQuota;
      if (!Number.isFinite(quota.Max24HourSend) || !Number.isFinite(quota.SentLast24Hours)) throw new Error('Invalid quota');
      const sesLeft = quota.Max24HourSend === -1 ? Infinity : quota.Max24HourSend - quota.SentLast24Hours;
      return result(Math.min(orgLeft, sesLeft) > 0, `今日の残り${Math.max(0, orgLeft)}件／SES ${sesLeft === Infinity ? '制限なし' : Math.max(0, sesLeft)}件`, Math.min(orgLeft, sesLeft) < Math.max(1, config.daily_send_cap * 0.1));
    });
    await check('send_lock', '送信ロック', 'SENDER', '使用中の配信が終わるまで待ち、配信画面で状況を確認してください。', async () => {
      const lock = await runtime.lock.get();
      return result(true, lock?.owner ?? '', !!lock?.owner);
    });
    let campaigns;
    try { campaigns = []; for await (const item of allRecords(runtime, 'CAMPAIGN')) campaigns.push(item); } catch { campaigns = undefined; }
    for (const [id, title, predicate] of [
      ['needs_review', '要確認の配信', (item) => item.status === 'NEEDS_REVIEW'],
      ['system_paused', 'システムが止めた配信', (item) => item.status === 'PAUSED' && item.pause_reason !== 'USER'],
      ['unknown_review', '結果不明の調査が残っている配信', (item) => item.unknown_review?.status === 'OPEN'],
      ['schedule_delayed', '予約が遅れている配信', (item) => item.status === 'SCHEDULED' && runtime.now() > Date.parse(item.scheduled_at) + 900000],
    ]) await check(id, title, 'ADMIN', '該当する配信を開き、理由と配送記録を確認してください。', async () => {
      if (!campaigns) throw new Error('Campaigns unavailable');
      const count = campaigns.filter(predicate).length;
      return result(true, `${count}件`, count > 0);
    });
    await check('administrators', '管理者の人数', 'ADMIN', 'スタッフ画面で管理者を追加し、2人以上にしてください。', async () => {
      const count = enabledAdmins(await listStaff(runtime)).length;
      return result(count > 0, `${count}人`, count === 1);
    });
    await check('erase_key', '完全削除用の鍵の状態', 'AWS_ADMIN', '完全削除用のKMS鍵を復旧してください。登録・取込・再同意は開始できません。', async () => {
      let response;
      try { response = await runtime.kms.generateMac({ KeyId: runtime.eraseMacKeyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from('ht2-readiness-key-check', 'utf8') }); } catch (error) {
        if (['DisabledException', 'KMSInvalidStateException', 'NotFoundException', 'AccessDeniedException'].includes(error.name)) return result(false);
        throw error;
      }
      if (!(response.Mac instanceof Uint8Array) || response.Mac.length !== 32) throw new Error('Invalid key check response');
      return result(true);
    });
    return { checked_at: new Date(runtime.now()).toISOString(), items };
  };
  return async () => {
    if (cache && runtime.now() < cache.expires) return structuredClone(cache.value);
    if (!pending) {
      const started = runtime.now();
      pending = load().then((value) => { cache = { value, expires: started + 60000 }; return value; }).finally(() => { pending = undefined; });
    }
    return structuredClone(await pending);
  };
}

async function get({ runtime, user }) {
  runtime.readiness ??= createReadiness(runtime);
  const response = await runtime.readiness();
  if (!user.roles.includes('admin')) for (const item of response.items) delete item.detail;
  return response;
}

export default { 'readiness.get': get };
