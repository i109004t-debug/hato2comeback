import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDns } from '../../src/worker/modes/daily.js';
import { managementFixture } from '../helpers/management.js';

for (const suffix of ['all', '+all', '?all', '+all -all', 'all ~all', '-all ~all', '~all include:example.com', '~all all', '+all/0 -all']) {
  test(`SPFは全許可・中立・複数all・終端以外allを拒否する: ${suffix}`, async () => {
    const f = managementFixture({ count: 0 });
    const original = f.deps.dns.resolveTxt;
    f.deps.dns.resolveTxt = async (name) => name.startsWith('_dmarc.') ? original(name) : [[`v=spf1 include:amazonses.com ${suffix}`]];
    const result = await checkDns(f.deps, f.identity);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.checks.FROM_SPF, false);
    assert.equal(result.checks.MAIL_FROM_SPF, false);
  });
}

for (const suffix of ['~all', '-all']) {
  test(`SPFはSES includeと単一の${suffix}終端を許可する`, async () => {
    const f = managementFixture({ count: 0 });
    const original = f.deps.dns.resolveTxt;
    f.deps.dns.resolveTxt = async (name) => name.startsWith('_dmarc.') ? original(name) : [[`v=spf1 include:amazonses.com ${suffix}`]];
    assert.equal((await checkDns(f.deps, f.identity)).status, 'PASS');
  });
}
