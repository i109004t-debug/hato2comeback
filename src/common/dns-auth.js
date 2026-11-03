import * as dns from 'node:dns/promises';
import { createHash } from 'node:crypto';

function safeSesSpf(record) {
  const terms = record.toLowerCase().split(/\s+/).slice(1);
  const all = terms.filter((term) => /^[+?~-]?all(?:$|[:/=])/.test(term));
  const broad = terms.some((term) => {
    if (/^[?~-]/.test(term)) return false;
    const mechanism = term.replace(/^\+/, '');
    const ip = /^(ip[46]):[^/]+\/(\d+)$/.exec(mechanism);
    if (ip) return Number(ip[2]) < (ip[1] === 'ip4' ? 8 : 16);
    const host = /^(?:a|mx)(?::[^/]+)?(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(mechanism);
    return host && (host[1] !== undefined && Number(host[1]) < 8 || host[2] !== undefined && Number(host[2]) < 16);
  });
  return !broad && terms.includes('include:amazonses.com') && all.length === 1 && ['~all', '-all'].includes(terms.at(-1));
}

export async function checkDns(runtime, identity) {
  const resolver = runtime.dns ?? dns;
  const domain = runtime.senderDomain;
  const mail = `bounce.${domain}`;
  const checks = {};
  const observed = {};
  const reasons = new Set();
  let unknown = false;
  const canonical = (value) => value.toLowerCase().replace(/\.$/, '');
  const read = async (method, name) => {
    try { return await resolver[method](name); } catch (error) {
      if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(error.code)) return [];
      unknown = true;
      reasons.add('DNS_UNAVAILABLE');
      return [];
    }
  };
  const check = (name, ok) => { checks[name] = ok; if (!ok) reasons.add(name); };
  for (const [label, name] of [['FROM_SPF', domain], ['MAIL_FROM_SPF', mail], ['DMARC', `_dmarc.${domain}`]]) {
    const records = (await read('resolveTxt', name)).map((parts) => parts.join('').trim().replace(/\s+/g, ' ')).sort();
    const selected = records.filter((record) => label === 'DMARC' ? /^v=DMARC1(?:;|\s|$)/i.test(record) : /^v=spf1(?:\s|$)/i.test(record));
    observed[label] = selected;
    if (label === 'DMARC') {
      const fields = Object.fromEntries((selected[0] ?? '').split(';').map((part) => part.trim().split(/\s*=\s*/)));
      check(label, selected.length === 1 && ['none', 'quarantine', 'reject'].includes(fields.p) && fields.aspf !== 's');
    } else check(label, selected.length === 1 && safeSesSpf(selected[0]));
  }
  const mx = (await read('resolveMx', mail)).map((item) => `${item.priority} ${canonical(item.exchange)}`).sort();
  observed.MAIL_FROM_MX = mx;
  check('MAIL_FROM_MX', mx.length === 1 && mx[0] === '10 feedback-smtp.ap-northeast-1.amazonses.com');
  const a = (await read('resolve4', domain)).sort();
  const fromMx = (await read('resolveMx', domain)).map((item) => `${item.priority} ${canonical(item.exchange)}`).sort();
  observed.FROM_A = a; observed.FROM_MX = fromMx;
  check('FROM_A_OR_MX', a.length > 0 || fromMx.length > 0);
  const tokens = identity?.DkimAttributes?.Tokens ?? [];
  const zone = identity?.DkimAttributes?.SigningHostedZone;
  check('DKIM_RECORDS', tokens.length === 3 && typeof zone === 'string' && zone.length > 0);
  observed.DKIM = [];
  for (const token of [...tokens].sort()) {
    if (!/^[a-z0-9]+$/i.test(token) || !zone) { check('DKIM_RECORDS', false); continue; }
    const values = (await read('resolveCname', `${token}._domainkey.${domain}`)).map(canonical).sort();
    observed.DKIM.push([token, values]);
    if (values.length !== 1 || values[0] !== canonical(`${token}.${zone}`)) check('DKIM_RECORDS', false);
  }
  return {
    status: unknown ? 'UNKNOWN' : reasons.size ? 'FAIL' : 'PASS', checks, reason_codes: [...reasons].sort(),
    dns_item_hashes: unknown ? {} : Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, createHash('sha256').update(JSON.stringify(value)).digest('hex')])),
    dns_config_hash: unknown ? '' : createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
  };
}

