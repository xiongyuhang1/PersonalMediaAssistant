import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliAdapter } from '../lib/cloud/adapters.ts';
import { AppError } from '../lib/cloud/security.ts';
import { runBilibiliProbe, claimBilibiliProbe } from '../lib/cloud/bilibili-diagnostics.ts';
import { DatabaseSync } from 'node:sqlite';

const cookie = 'SESSDATA=private-session-fixture; buvid3=provider-fixture; bili_jct=private-csrf-fixture';
test('HTTP 412 retains JSON code independently; HTML does not invent business -412 or leak body', async () => {
  for (const [body, expected] of [[JSON.stringify({ code: -352, message: cookie, data: { mid: 'private-account' } }), -352], ['<!doctype html><html>访问权限不足 private-account</html>', null]] as const) {
    const adapter = new BilibiliAdapter({ biliCookie: cookie }, (async () => new Response(body, { status: 412, headers: { 'Set-Cookie': cookie } })) as typeof fetch);
    await assert.rejects(adapter.page('history'), (error: unknown) => {
      assert.ok(error instanceof AppError); assert.equal(error.code, 'RISK_CONTROLLED');
      assert.equal(error.upstream?.http_status, 412); assert.equal(error.upstream?.business_code, expected);
      const output = JSON.stringify(error.upstream); assert.ok(!output.includes('private-')); assert.ok(!output.includes('Set-Cookie'));
      return true;
    });
  }
});
test('WBI -352 at HTTP 200 stops after one signed call, without refreshing or retrying', async () => {
  const paths: string[] = [];
  const adapter = new BilibiliAdapter({ biliCookie: cookie }, (async (input) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    return Response.json(url.pathname.endsWith('/nav') ? { code: 0, data: { wbi_img: { img_url: 'https://i.example/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png' } } } : { code: -352, message: cookie });
  }) as typeof fetch);
  await assert.rejects(adapter.search('fixture'), (e: unknown) => e instanceof AppError && e.upstream?.http_status === 200 && e.upstream?.business_code === -352 && e.upstream?.signed === true);
  assert.deepEqual(paths, ['/x/web-interface/nav', '/x/web-interface/wbi/search/type']);
});
test('missing provider buvid never fabricates a device or continues after spi risk', async () => {
  const paths: string[] = [];
  const adapter = new BilibiliAdapter({ biliCookie: 'SESSDATA=fixture' }, (async (input) => { paths.push(new URL(String(input)).pathname); return Response.json({ code: -352, data: null }); }) as typeof fetch);
  await assert.rejects(adapter.search('fixture'));
  assert.deepEqual(paths, ['/x/frontend/finger/spi']);
});
test('risk in WBI nav dependency remains risk and identifies the unsigned failing path', async () => {
  const adapter = new BilibiliAdapter({ biliCookie: cookie }, (async () => Response.json({ code: -352, data: null })) as typeof fetch);
  await assert.rejects(adapter.search('fixture'), (e: unknown) => e instanceof AppError && e.code === 'RISK_CONTROLLED' && e.upstream?.path === '/x/web-interface/nav' && e.upstream.signed === false && e.upstream.business_code === -352);
});
test('baseline stops on first risk, canonical tags compare same credentials, independent controls stay bounded', async () => {
  const input = { group: 'baseline' as const, salt: '0'.repeat(32) };
  let requests = 0;
  const fetcher = (async (_input, init) => { requests++; assert.equal(init?.redirect, 'manual'); return new Response('<html>风控 private-account</html>', { status: 412 }); }) as typeof fetch;
  const first = await runBilibiliProbe(cookie, input, fetcher); assert.equal(requests, 1); assert.equal(first.checks[1].status, 'skipped');
  const second = await runBilibiliProbe('bili_jct=private-csrf-fixture; SESSDATA=private-session-fixture; buvid3=provider-fixture', { ...input, group: 'controls' }, fetcher);
  assert.equal(requests, 3); assert.equal(second.upstream_requests, 2); assert.equal(first.credential.cookie_tag, second.credential.cookie_tag);
  assert.ok(!JSON.stringify(first).includes('private-'));
});
test('D1 diagnostic cooldown is atomic per group and cannot be bypassed with salt', async () => {
  const sql = new DatabaseSync(':memory:'); sql.exec('CREATE TABLE pma_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const db = { prepare: (query: string) => ({ bind: (...args: any[]) => ({ first: async () => sql.prepare(query).get(...args) ?? null }) }) } as unknown as D1Database;
  try {
    await claimBilibiliProbe({ DB: db }, 'baseline', 1000);
    await assert.rejects(claimBilibiliProbe({ DB: db }, 'baseline', 1001), /DIAGNOSTIC_COOLDOWN/);
    await claimBilibiliProbe({ DB: db }, 'controls', 1001);
    await claimBilibiliProbe({ DB: db }, 'baseline', 601000);
  } finally { sql.close(); }
});
