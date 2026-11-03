export const ERROR_MESSAGES = Object.freeze({
  EVIDENCE_TOO_LARGE: '証跡のファイルは1MiB以下にしてください。',
  SELF_CHANGE_FORBIDDEN: '自分自身のアカウントは変更できません。別の管理者に依頼してください。',
  LAST_ADMIN: '有効な管理者を0人にはできません。1人になる変更は警告の確認が必要です。一覧を読み直して確認してください。',
  REAUTH_REQUIRED: 'スタッフを変更するには、ログアウトしてからログインし直してください。',
  CHECK_HASH_CHANGED: '検査を始めた後に送信設定かDNSが変わりました。新しい受入検査を始めてください。',
  OUTSIDE_APPROVED_WINDOW: '承認された送信期間の範囲外です。期間内の日時を指定してください。',
  AUDIENCE_EXCEEDS_APPROVAL: '宛先が承認の最大件数を超えたため、送らずに承認待ちへ戻りました。範囲を見直して承認してください。',
  CAPACITY_INSUFFICIENT: 'この配信は期限までに送り終えられません。管理者に1日の上限の引き上げを依頼するか、期限を延ばして承認し直してください。',
  TOO_MANY_RECIPIENTS: '宛先がシステムの配信上限を超えています。管理者に確認してください。',
  DEADLINE_PASSED: '送信期限を過ぎたため、残りを送らずに中止しました。',
  SCHEDULE_DELAYED: '予約日時から15分を過ぎても開始していません。他の配信の状況を確認してください。',
  UNKNOWN_REVIEW_OPEN: '結果不明の調査が3日を過ぎています。管理者が調べて判断を記録してください。',
  EVENTS_MISSING: '受付件数に対して配送の記録が不足しています。管理者が記録を確認し、原因を直してください。',
  CONSENT_SOURCE_HAS_ADDRESS: '同意の取得経路にはメールアドレスを含めず、申込方法などを記入してください。',
  ERASE_CHECK_UNAVAILABLE: '完全削除の記録を確認できません。AWSの管理者が鍵の状態を確認してください。',
  UNSUPPORTED_SCHEMA: 'この記録の形式に対応していません。AWSの管理者が実行環境とコードの版を確認してください。',
  AUTH_CHECK_STALE: '設定を変更したため、送信元の確認をやり直しています。数分後にもう一度お試しください。',
  IMPORT_REQUIRES_PRODUCTION: 'SESのサンドボックスではCSV取込を使えません。1件ずつ登録してください。',
  INVALID_REQUEST: '入力の形式を確認してください。', UNAUTHENTICATED: 'ログインの有効期限が切れました。再ログインしてください。',
  FORBIDDEN: 'この操作の権限がありません。管理者に確認してください。', FORBIDDEN_ORIGIN: '運営画面のURLから開き直してください。', USER_DISABLED: 'アカウントが無効です。管理者に確認してください。', NO_ROLE: '役割が設定されていません。管理者に確認してください。', NOT_FOUND: '対象の記録が見つかりません。',
  STATE_CONFLICT: '他の人が先に操作しました。画面を読み込み直してください。', VERSION_CONFLICT: '他の人が先に操作しました。画面を読み込み直してください。', HASH_MISMATCH: '承認画面を開いた後に内容が変わりました。画面を読み込み直し、内容を確かめてから承認してください。',
  CONTACT_EXISTS: 'この宛先は登録済みです。既存の購読状態は変わりません。', ERASED_ADDRESS: '完全削除した宛先は登録できません。', RECONSENT_REQUIRED: '購読の再開には、管理者による新しい同意の証跡の登録が必要です。', ALREADY_STARTED: '配信はすでに始まっています。配信状況を確認してください。', SENDING_IN_PROGRESS: '他の配信が送信中です。終わるまでお待ちください。', CONTACT_IMPORT_IN_PROGRESS: '宛先の登録・取込を処理中です。終わるまでお待ちください。',
  PAYLOAD_TOO_LARGE: '本文は50KiB以下、CSVは2MiB以下にしてください。', SETTINGS_INCOMPLETE: '法定表示などの組織設定が足りません。管理者が設定してください。', INVALID_ADDRESS: 'メールアドレスの形式を確認してください。', NONSTANDARD_ADDRESS: 'この形式のメールアドレスは登録できません。会員に別のアドレスを確認してください。',
  QUOTA_INSUFFICIENT: 'SESの24時間の送信枠が足りません。枠が戻るのをお待ちください。いつも足りなければAWSの管理者に引上げを依頼してください。', TEST_RECIPIENT_NOT_REGISTERED: 'テスト送信先の登録と、配信リストの購読を確認してください。', RECIPIENT_NOT_ALLOWED_IN_ENV: 'この環境で許可されたテスト用の宛先を使ってください。', DELIVERY_CHECK_REQUIRED: '受信確認の記録がない、または期限切れ・設定変更で無効です。管理者が受信確認をやり直してください。',
  SES_BUSY: 'SESが混み合っています。しばらく待って、配信状況を確認してください。', SES_PAUSED: 'SESが送信を止めています。AWSの管理者が理由を確認してください。', SENDING_DISABLED: '全体の停止スイッチが入っています。AWSの管理者が理由を確認してください。', REPUTATION_ALARM: 'バウンス率や苦情率の警報が出ています。原因を直し、警報が解除されるまでお待ちください。', AUTH_CHECK_FAILED: '送信元ドメインの認証に異常があります。AWSの管理者がDNSとSESの状態を確認してください。',
  EVENT_DESTINATION_DISABLED: '配送の記録が無効です。AWSの管理者が復旧してください。', EVENT_LOG_STALE: '配送の記録が遅れています。AWSの管理者が復旧してください。', MONITORING_UNAVAILABLE: '配送の記録や監視の状態を確認できません。AWSの管理者が復旧してください。', SUPPRESSION_MISCONFIGURED: '配送しない宛先の管理設定に異常があります。AWSの管理者が復旧してください。', CONFIGURATION_INVALID: 'システムの設定を確認できません。AWSの管理者が復旧してください。', INTERNAL: '処理を完了できませんでした。問い合わせ番号を管理者にお知らせください。', NETWORK: '通信結果を確認できません。操作を繰り返さず、画面を読み込み直して配信状況・取込結果を確認してください。',
});

const FIELD_LABELS = Object.freeze({ topic: '配信リスト', subject: '件名', body_text: '本文', at: '日時', email: 'メールアドレス', name: '名前', consent: '同意の記録', reconsent: '新しい同意の証跡', topics: '配信リスト', note: '理由・確認内容', reason: '理由', from_local: '差出人のアドレス', from_name: '差出人名', reply_to: '返信先', legal: '法定表示', test_recipients: 'テスト送信先', max_rate_per_sec: '送信速度の上限', evidence_key: '確認の証跡', version: '情報の版', content_sha256: '内容のハッシュ', cases: '受信確認の試験結果', config_hash: '送信設定の確認値', dns_config_hash: 'DNS設定の確認値' });

export class ApiError extends Error {
  constructor(code, status = 0, requestId = '', fields = []) {
    const knownCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'INTERNAL';
    super(ERROR_MESSAGES[knownCode]);
    this.name = 'ApiError';
    this.code = knownCode;
    this.status = status;
    this.requestId = requestId;
    this.fields = fields;
  }
}

export function convertError(body, status) {
  const code = typeof body?.error_code === 'string' && Object.hasOwn(ERROR_MESSAGES, body.error_code) ? body.error_code : status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL';
  const requestId = typeof body?.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.request_id) ? body.request_id : '';
  const fields = [...new Set((Array.isArray(body?.field_errors) ? body.field_errors : []).map((item) => {
    const key = typeof item?.field === 'string' ? item.field.split(/[.\[]/)[0] : '';
    return Object.hasOwn(FIELD_LABELS, key) ? FIELD_LABELS[key] : undefined;
  }).filter(Boolean))];
  return new ApiError(code, status, requestId, fields);
}

export function errorText(error) {
  const value = error instanceof ApiError ? error : new ApiError(error?.message === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'INTERNAL');
  return `${value.message}${value.fields.length ? ` 確認する項目：${value.fields.join('、')}。` : ''}${value.requestId ? ` 問い合わせ番号：${value.requestId}` : ''}`;
}

export function isUncertainMutation(error) {
  return !(error instanceof ApiError) || ['NETWORK', 'INTERNAL'].includes(error.code) || error.status >= 500;
}

export function apiPath(path, query = {}) {
  if (!/^\/(?:me|readiness|staff(?:\/[A-Za-z0-9_-]{1,128}\/(?:roles|disable|enable|reset-mfa|reset-password))?|settings(?:\/delivery-check(?:\/[0-9A-HJKMNP-TV-Z]{26}\/(?:cases\/T-\d{2}|evidence|submit))?)?|topics|contacts(?:\/(?:get|update|unsubscribe|reconsent|erase|events))?|imports(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/(?:confirm|discard))?)?|campaigns(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/(?:preview|test-send|submit|approve|reject|start|unschedule|pause|resume|cancel|review|stats|failures|unknowns))?)?|audit)$/.test(path)) throw new ApiError('INVALID_REQUEST');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!['limit', 'cursor', 'topic', 'status', 'month', 'send_by', 'send_after', 'mode'].includes(key)) throw new ApiError('INVALID_REQUEST');
    if (value !== undefined && value !== null && value !== '') {
      const text = String(value);
      const valid = ['send_by', 'send_after'].includes(key) ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) : /^[A-Za-z0-9_-]+$/.test(text);
      if (text.includes('@') || !valid) throw new ApiError('INVALID_REQUEST');
      params.set(key, text);
    }
  }
  return path + (params.size ? `?${params}` : '');
}

export function createApi({ auth, fetchFn = fetch, baseUrl = '/api/v1', onUnauthenticated = () => {} }) {
  if (baseUrl !== '/api/v1') throw new ApiError('CONFIGURATION_INVALID');
  async function request(path, { method = 'GET', body, query, csv, idempotencyKey, signal } = {}) {
    const url = baseUrl + apiPath(path, query);
    const execute = async (token) => {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      if (body !== undefined || csv !== undefined) headers['Content-Type'] = csv !== undefined ? 'text/csv; charset=utf-8' : 'application/json';
      if (idempotencyKey) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) throw new ApiError('INVALID_REQUEST');
        headers['Idempotency-Key'] = idempotencyKey;
      }
      try { return await fetchFn(url, { method, headers, ...(csv !== undefined ? { body: csv } : body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal }); }
      catch { throw new ApiError('NETWORK'); }
    };
    let response;
    try {
      response = await execute(await auth.accessToken());
      if (response.status === 401) {
        let rejection;
        try { rejection = await response.json(); } catch { /* 不正な401は通常の更新失敗として扱う。 */ }
        if (rejection?.error_code === 'REAUTH_REQUIRED') {
          await auth.logout();
          throw new ApiError('REAUTH_REQUIRED', 401);
        }
        response = await execute(await auth.refresh());
      }
    } catch (error) {
      if (error?.message === 'UNAUTHENTICATED') { auth.clear(); onUnauthenticated(); throw new ApiError('UNAUTHENTICATED', 401); }
      throw error;
    }
    let data;
    try { data = await response.json(); } catch {
      if (response.status === 401) { auth.clear(); onUnauthenticated(); throw new ApiError('UNAUTHENTICATED', 401); }
      throw new ApiError('INTERNAL', response.status);
    }
    if (!response.ok) {
      if (response.status === 401) { auth.clear(); onUnauthenticated(); }
      throw convertError(data, response.status);
    }
    return data;
  }
  return { request };
}
