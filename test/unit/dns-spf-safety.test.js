import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDns } from '../../src/worker/modes/daily.js';
import { managementFixture } from '../helpers/management.js';

async function spfResult(term) {
  const f = managementFixture({ count: 0 });
  const original = f.deps.dns.resolveTxt;
  f.deps.dns.resolveTxt = async (name) => name.startsWith('_dmarc.') ? original(name) : [[`v=spf1 include:amazonses.com ${term} -all`]];
  return checkDns(f.deps, f.identity);
}

const broadMechanisms = ['ip4:0.0.0.0/0', 'ip4:10.0.0.0/7', 'ip6:::/0', 'ip6:2001:db8::/15', 'a/0', 'a:example.jp/7', 'mx/0', 'mx:example.jp/7', 'a//0', 'mx:example.jp//15', 'a:example.jp/24//15', 'mx/7//64'];
for (const mechanism of broadMechanisms) {
  for (const qualifier of ['', '+']) {
    test(`SPFは許可範囲が広すぎる機構を拒否する: ${qualifier}${mechanism}`, async () => {
      const result = await spfResult(qualifier + mechanism);
      assert.equal(result.status, 'FAIL');
      assert.equal(result.checks.FROM_SPF, false);
      assert.equal(result.checks.MAIL_FROM_SPF, false);
    });
  }
}

for (const qualifier of ['-', '~', '?']) {
  test(`SPFの広すぎる範囲の検査は${qualifier}修飾子を対象外とする`, async () => {
    for (const mechanism of broadMechanisms) assert.equal((await spfResult(qualifier + mechanism)).status, 'PASS', qualifier + mechanism);
  });
}

test('SPFはIPv4 /8・IPv6 /16の境界と通常のa・mxを許可する', async () => {
  for (const mechanism of ['ip4:10.0.0.0/8', 'ip4:192.0.2.1/32', 'ip6:2001::/16', 'ip6:2001:db8::1/128', 'a', 'mx', 'a/8', 'mx:example.jp/8', 'a//16', 'mx:example.jp//16', 'a:example.jp/8//16', 'mx/24//64']) {
    for (const qualifier of ['', '+']) assert.equal((await spfResult(qualifier + mechanism)).status, 'PASS', qualifier + mechanism);
  }
});

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
