import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash, publicEncrypt, constants } from 'node:crypto';
import { CloudStore } from '../lib/cloud/store.ts';
import { MediaService } from '../lib/cloud/service.ts';
import { recordSchema, ingestSchema, querySchema } from '../lib/cloud/contracts.ts';
import { weapi, eapi, neteaseRequest } from '../lib/cloud/netease-transport.ts';
import { safeFetch } from '../lib/cloud/adapters.ts';
import { gatewayStatus, handleMcp, limitedText, tools } from '../lib/gateway-core.ts';
import { exportDescriptor, exportLines, exportResponse } from '../lib/cloud/export.ts';
import { insightPlatforms, insightsSchema } from '../lib/cloud/insights.ts';
import { syncFromWeb } from '../lib/cloud/web-sync.ts';
import { migrateTestDatabase } from './migrations.ts';
const cursorKey = 'test-only-key-for-cloud-pagination-not-real';
class Statement {
  values: any[] = [];
  constructor(public database: DatabaseSync, public sql: string) {}
  bind(...args: any[]) { const result = new Statement(this.database, this.sql); result.values = args; return result; }
  async first(column?: string) { const row = this.database.prepare(this.sql).get(...this.values); return column ? row?.[column] ?? null : row ?? null; }
  async all() { return this.execute(); }
  async run() { this.database.prepare(this.sql).run(...this.values); return { success: true, results: [], meta: {} }; }
  execute() { return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: {} }; }
}
function fixture() {
  const sql = new DatabaseSync(':memory:');
  migrateTestDatabase(sql);
  const db = { prepare: (statement: string) => new Statement(sql, statement), batch: async (statements: Statement[]) => { sql.exec('BEGIN'); try { const value = statements.map(s => s.execute()); sql.exec('COMMIT'); return value; } catch (error) { sql.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
  return { sql, db, store: new CloudStore(db, cursorKey), env: { DB: db, PMA_CURSOR_KEY: cursorKey, PMA_INGEST_DEVICE_ID: 'windows-primary', PMA_INGEST_TOKEN: 'test-only-device-key-not-a-real-credential' } };
}
const sample = (id: string, extra: Record<string, unknown> = {}) => recordSchema.parse({ id, content_id: id, platform: 'dandanplay', dataset: 'episodes', title: `Episode ${id}`, record_kind: 'last_watch_observation', collected_at: '2026-11-02T00:00:00Z', ...extra });
test('D1 绑定第一位私有站点所有者，拒绝其他身份', async () => {
  const f = fixture(); try { await f.store.owner('owner-one'); await f.store.owner('owner-one'); await assert.rejects(f.store.owner('someone-else'), /OWNER_ONLY/); } finally { f.sql.close(); }
});
test('D1 增量批次原子提交、幂等及冲突保护', async () => {
  const f = fixture(); try { const batch = { device_id: 'windows-primary', batch_id: 'batch-test-1', items: [sample('one')] };
    assert.equal((await f.store.ingest(batch)).duplicate, false); assert.equal((await f.store.ingest(batch)).duplicate, true);
    await assert.rejects(f.store.ingest({ ...batch, items: [sample('other')] }), /BATCH_ID_CONFLICT/);
    assert.equal((await f.store.query(querySchema.parse({}))).items.length, 1);
  } finally { f.sql.close(); }
});
test('无日期的已看完断言可以保存，不产生观看时间', async () => {
  const f = fixture(); try { const item = sample('complete', { dataset: 'watchlist', record_kind: 'completion_assertion', completion_state: 'completed', completion_basis: 'explicit_user_statement', all_episodes_completed: true });
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'batch-test-2', items: [item] });
    const row = (await f.store.query(querySchema.parse({}))).items[0]; assert.equal(row.all_episodes_completed, true); assert.equal(row.source_time, undefined);
  } finally { f.sql.close(); }
});
test('真实关注状态按服务端过滤，完成断言无日期也可查询，更新不重复', async () => {
  const f = fixture(); try {
    const work = (id: string, status: number, rating: number | null) => sample(id, { dataset: 'watchlist', record_kind: 'collection_state', following: true, favorite_status: status, completion_state: ['not_completed', 'completed', 'abandoned'][status], completion_basis: 'explicit_source_status', all_episodes_completed: status === 1, user_rating: rating, user_rating_state: rating === null ? 'unrated' : 'rated' });
    const items = [work('a', 0, 6), work('b', 1, 10), work('c', 1, null), work('d', 2, 8), sample('e', { dataset: 'watchlist', record_kind: 'collection_state', following: false, completion_state: 'unknown', user_rating_state: 'unrated', user_rating: null }), sample('episode')];
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'status-test-1', items });
    const first = await f.store.query(querySchema.parse({ following: true, completion_state: 'completed', limit: 1 }));
    const second = await f.store.query(querySchema.parse({ following: true, completion_state: 'completed', limit: 1, cursor: first.next_cursor }));
    assert.deepEqual([...first.items, ...second.items].map(i => i.id), ['b', 'c']);
    await assert.rejects(f.store.query(querySchema.parse({ following: false, completion_state: 'completed', cursor: first.next_cursor })), /INVALID_CURSOR/);
    assert.equal((await f.store.query(querySchema.parse({ user_rating: 6 }))).items[0].id, 'a');
    assert.equal((await f.store.query(querySchema.parse({ rating_state: 'unrated' }))).items.length, 2);
    assert.equal((await f.store.query(querySchema.parse({ completion_state: 'completed', after: '2026-01-01T00:00:00Z' }))).items.length, 0);
    const service = new MediaService(f.env);
    const result: any = await service.call('dandanplay_get_episode_progress', { anime_id: 'b' });
    assert.equal(result.items.length, 0); assert.equal(result.work_status.all_episodes_completed, true); assert.equal(result.work_status.source_time, undefined);
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'status-test-2', items: [work('a', 1, 6)] });
    const summary = await f.store.watchlistSummary();
    assert.equal(summary.anime_records, 5); assert.deepEqual(summary.following_completion, { not_completed: 0, completed: 3, abandoned: 1, unknown: 0 });
  } finally { f.sql.close(); }
});
test('个人评分含义可持久保存，0未评分，6含义明确，未来分值不推断', async () => {
  const f = fixture(); try {
    const item = sample('ratings', { dataset: 'watchlist', record_kind: 'collection_state', user_rating: 9, user_rating_state: 'rated', community_rating: 7.2 });
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'rating-test-1', items: [item] });
    const result: any = await new MediaService(f.env).call('dandanplay_get_watchlist', {});
    assert.equal(result.items[0].user_rating, 9); assert.equal(result.items[0].community_rating, 7.2);
    assert.equal(result.rating_scale.labels['6'], '勉强能看下去'); assert.equal(result.rating_scale.labels['3'], undefined); assert.equal(result.rating_scale.labels['9'], undefined);
    const stored: any = await f.db.prepare("SELECT value FROM pma_meta WHERE key='dandanplay_rating_scale'").first();
    assert.deepEqual(JSON.parse(stored.value), result.rating_scale);
    assert.equal(recordSchema.safeParse({ ...item, user_rating: 0 }).success, false);
    assert.equal(recordSchema.safeParse({ ...item, user_rating_state: 'unrated' }).success, false);
    assert.equal(recordSchema.safeParse({ ...item, favorite_status: 1, completion_state: 'unknown' }).success, false);
  } finally { f.sql.close(); }
});
test('拒绝原始路径、Cookie 以及超过设备批次范围的数据', async () => {
  const f = fixture(); try { const service = new MediaService(f.env);
    assert.equal(ingestSchema.safeParse({ schema_version: '1.0', device_id: 'windows-primary', batch_id: 'batch-test-3', items: [{ ...sample('one'), FilePath: 'C:/sensitive' }] }).success, false);
    await assert.rejects(service.ingest({ schema_version: '1.0', device_id: 'other-device', batch_id: 'batch-test-3', items: [sample('one')] }), /DEVICE_SCOPE_DENIED/);
    await assert.rejects(service.ingest({ schema_version: '1.0', device_id: 'windows-primary', batch_id: 'batch-test-3', items: Array.from({ length: 31 }, (_, i) => sample(String(i))) }), /BATCH_TOO_LARGE/);
  } finally { f.sql.close(); }
});
test('大型游戏快照分多次提交，续传不会删除上一页', async () => {
  const f = fixture(); try { const service = new MediaService(f.env); const records = Array.from({ length: 400 }, (_, i) => sample(String(i).padStart(3, '0'), { platform: 'steam', dataset: 'owned_games', record_kind: 'library_snapshot' }));
    service.adapters.set('steam', { configured: true, datasets: ['owned_games'], page: async () => ({ items: records, snapshot: true }) } as any);
    const first = await service.sync({ platform: 'steam', dataset: 'owned_games' }); assert.equal(first.records_committed, 180); assert.equal(first.has_more, true); assert.equal(first.last_successful_sync_at, null);
    await service.sync({ platform: 'steam', dataset: 'owned_games' }); const last = await service.sync({ platform: 'steam', dataset: 'owned_games' }); assert.equal(last.has_more, false);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM media_records').first<{ n: number }>())!.n, 400);
  } finally { f.sql.close(); }
});
test('失败保留已提交游标与最后成功时间，允许其他源继续查询', async () => {
  const f = fixture(); try { await f.store.page('bilibili', 'history', [], { max: 123 }, 'gen', false, 'test');
    const service = new MediaService(f.env); service.adapters.set('bilibili', { configured: true, datasets: ['history'], page: async () => { throw new Error('Cookie=DO-NOT-EXPOSE'); } } as any);
    await assert.rejects(service.sync({ platform: 'bilibili', dataset: 'history' }), /UPSTREAM_CHANGED/);
    assert.deepEqual(JSON.parse((await f.store.state('bilibili', 'history'))!.cursor), { max: 123 });
    const status = await f.store.status(service.configured()); assert.equal(status.platforms.find(p => p.platform === 'bilibili')!.state, 'failed'); assert.equal(JSON.stringify(status).includes('DO-NOT-EXPOSE'), false);
  } finally { f.sql.close(); }
});
test('过滤在分页前执行，游标绑定过滤器并限制返回大小', async () => {
  const f = fixture(); try { await f.store.page('dandanplay', 'episodes', Array.from({ length: 40 }, (_, i) => sample(String(i).padStart(3, '0'), { title: i % 2 ? 'other' : 'target' })), undefined, 'gen', false, 'test');
    const first = await f.store.query(querySchema.parse({ keyword: 'target', limit: 5 })); assert.equal(first.items.length, 5);
    const next = await f.store.query(querySchema.parse({ keyword: 'target', limit: 5, cursor: first.next_cursor })); assert.equal(new Set([...first.items, ...next.items].map(i => i.id)).size, 10);
    await assert.rejects(f.store.query(querySchema.parse({ keyword: 'other', cursor: first.next_cursor })), /INVALID_CURSOR/);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 16384);
  } finally { f.sql.close(); }
});
test('D1 日期过滤使用规范化真实时间，空日期不混入时间轴', async () => {
  const f = fixture(); try { await f.store.page('dandanplay', 'episodes', [sample('dated', { source_time: '2026-11-02T08:00:00+08:00' }), sample('undated')], undefined, 'gen', false, 'test');
    const page = await f.store.query(querySchema.parse({ after: '2026-11-02T00:00:00Z', before: '2026-11-02T01:00:00Z' })); assert.deepEqual(page.items.map(i => i.id), ['dated']);
  } finally { f.sql.close(); }
});
test('MCP 能发现37个实际工具；未认证拒绝、缺凭据明确失败', async () => {
  const f = fixture(); try {
    assert.equal(tools.length, 37);
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'steam_get_owned_games', arguments: {} } };
    assert.equal((await handleMcp(request, null, f.env)).http, 401);
    const result = await handleMcp(request, 'owner', f.env); const body: any = result.body;
    assert.equal(body.result.isError, true); assert.equal(JSON.parse(body.result.content[0].text).code, 'AUTH_REQUIRED');
    const status = await gatewayStatus(f.env, ['steam']); assert.equal(status.platforms[0].records, null);
  } finally { f.sql.close(); }
});
test('加密移植与上游 AES/RSA 语义一致，无真实 Cookie', () => {
  const key = 'abcdefghijklmnop'; const payload = { uid: '123', type: 0 }; const encrypted = weapi(payload, key);
  const decrypt = (value: Buffer, k: string, mode: string) => { const decipher = createDecipheriv(`aes-128-${mode}`, Buffer.from(k), mode === 'cbc' ? Buffer.from('0102030405060708') : Buffer.alloc(0)); return Buffer.concat([decipher.update(value), decipher.final()]).toString(); };
  const first = decrypt(Buffer.from(encrypted.params, 'base64'), key, 'cbc'); assert.deepEqual(JSON.parse(decrypt(Buffer.from(first, 'base64'), '0CoJUm6Qyw8W8jud', 'cbc')), payload);
  const path = '/api/song/like/get'; const e = eapi(path, payload); const plain = decrypt(Buffer.from(e.params, 'hex'), 'e82ckenh8dichen8', 'ecb');
  assert.equal(plain, `${path}-36cd479b6b5-${JSON.stringify(payload)}-36cd479b6b5-${createHash('md5').update(`nobody${path}use${JSON.stringify(payload)}md5forencrypt`).digest('hex')}`);
  assert.equal(encrypted.encSecKey.length, 256);
  const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----';
  const block = Buffer.alloc(128); Buffer.from([...key].reverse().join('')).copy(block, 112);
  assert.equal(encrypted.encSecKey, publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, block).toString('hex'));
});
test('设备心跳与数据更新时间分开，不能更改记录或虚构观看', async () => {
  const f = fixture(); try { const service = new MediaService(f.env); const ack = await service.heartbeat({ schema_version: '1.0', device_id: 'windows-primary', heartbeat: true });
    assert.equal(ack.accepted, true); assert.equal(ack.netease_crypto_runtime_ready, true);
    const status = await service.store.status(service.configured()); const anime = status.platforms.find(p => p.platform === 'dandanplay')!;
    assert.equal(anime.last_successful_sync_at, null); assert.equal(anime.records, null); assert.ok(anime.collector_last_seen_at);
    await assert.rejects(service.heartbeat({ schema_version: '1.0', device_id: 'other-device', heartbeat: true }), /DEVICE_SCOPE_DENIED/);
  } finally { f.sql.close(); }
});
test('流式请求体在超限时立即取消，不能先全量读进内存', async () => {
  const request = new Request('https://test.local/', { method: 'POST', body: 'x'.repeat(100) }); await assert.rejects(limitedText(request, 50), /BODY_TOO_LARGE/);
});
test('私有导出按页续传，包含反馈，拒绝匿名、跨用户和游标换范围', async () => {
  const f = fixture(); try {
    await f.store.owner('owner');
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'export-test-1', items: [sample('one'), sample('two'), sample('three')] });
    await new MediaService(f.env).call('save_recommendation_feedback', { request_id: 'feedback-export-test', platform: 'dandanplay', content_id: 'one', feedback: 'like', reason: 'explicit subjective reason' });
    await assert.rejects(exportResponse(f.store, null, {}), /AUTH_REQUIRED/);
    await assert.rejects(exportResponse(f.store, 'someone-else', {}), /OWNER_ONLY/);
    const first: any[] = []; for await (const item of exportLines(f.store, { platform: 'dandanplay', max_records: 2 })) first.push(item);
    assert.equal(first[0].type, 'manifest'); assert.equal(first.at(-1).complete, false);
    const cursor = first.at(-1).next_cursor;
    assert.throws(() => exportDescriptor(f.store, { platform: 'steam', cursor }), /INVALID_CURSOR/);
    assert.throws(() => exportDescriptor(f.store, { cursor: cursor + 'x' }), /INVALID_CURSOR/);
    const response = await exportResponse(f.store, 'owner', { platform: 'dandanplay', max_records: 2, cursor });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const last = (await response.text()).trim().split('\n').map(value => JSON.parse(value));
    assert.equal(last.at(-1).complete, true);
    const combined = [...first, ...last];
    assert.equal(new Set(combined.filter(v => v.type === 'record').map(v => v.record.id)).size, 3);
    assert.equal(combined.filter(v => v.type === 'feedback').length, 1);
    assert.equal(JSON.stringify(combined).includes('test-only-device-key'), false);
  } finally { f.sql.close(); }
});
test('导出损坏或未知字段时停止，不透出原始载荷', async () => {
  const f = fixture(); try {
    await f.store.owner('owner'); await f.store.ingest({ device_id: 'windows-primary', batch_id: 'export-test-2', items: [sample('one')] });
    f.sql.prepare('UPDATE media_records SET payload=?').run(JSON.stringify({ ...sample('one'), cookie: 'sensitive-do-not-export' }));
    const response = await exportResponse(f.store, 'owner', {}); const text = await response.text();
    assert.equal(text.includes('sensitive-do-not-export'), false); assert.equal(text.includes('EXPORT_RECORD_INVALID'), true);
  } finally { f.sql.close(); }
});
test('兴趣摘要按问题选择平台并明确缺口，不把未评分当不喜欢', async () => {
  const f = fixture(); try {
    assert.deepEqual(insightPlatforms(insightsSchema.parse({ focus: 'music' })), ['netease', 'bilibili']);
    assert.deepEqual(insightPlatforms(insightsSchema.parse({ focus: 'music', include_game_ost: true })), ['netease', 'bilibili', 'steam']);
    await f.store.ingest({ device_id: 'windows-primary', batch_id: 'insights-test-1', items: [sample('rated', { dataset: 'watchlist', record_kind: 'collection_state', user_rating: 6, user_rating_state: 'rated' }), sample('unrated', { dataset: 'watchlist', record_kind: 'collection_state', user_rating: null, user_rating_state: 'unrated' })] });
    const result: any = await new MediaService(f.env).call('analyze_cross_platform_interests', { focus: 'anime' });
    assert.equal(result.status, 'partial'); assert.deepEqual(result.queried_platforms, ['dandanplay', 'bilibili', 'netease']);
    assert.equal(result.sources[0].evidence.length, 1); assert.equal(result.sources[0].evidence[0].evidence_kind, 'explicit_personal_rating');
    assert.equal(result.sources[0].rating_scale.labels['6'], '勉强能看下去'); assert.equal(result.sources[1].source_status, 'auth_required');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16384);
  } finally { f.sql.close(); }
});
test('兴趣摘要隔离单个平台缓存故障，并在大字段下保持返回预算', async () => {
  const f = fixture(); try {
    for (const platform of ['steam', 'bilibili', 'netease', 'dandanplay'] as const) {
      const dataset = platform === 'steam' ? 'owned_games' : platform === 'bilibili' ? 'favorites' : platform === 'netease' ? 'user_record_week' : 'watchlist';
      const items = Array.from({ length: 5 }, (_, i) => sample(`${platform}-${i}`, { platform, dataset, record_kind: 'collection_state', title: '动画音乐'.repeat(150), artists: Array.from({ length: 30 }, () => '歌手'.repeat(80)), user_comment: '主观评价'.repeat(250), user_rating: 10, user_rating_state: 'rated', playtime_minutes: 100, rank: i + 1 }));
      await f.store.page(platform, dataset, items, undefined, 'large-fields', false, 'synthetic data');
    }
    const service = new MediaService(f.env); const full: any = await service.call('analyze_cross_platform_interests', {});
    assert.ok(Buffer.byteLength(JSON.stringify(full)) < 16384); assert.ok(full.sources.some((s: any) => s.evidence_truncated));
    f.sql.prepare("UPDATE media_records SET payload='invalid-json' WHERE platform='bilibili'").run();
    const partial: any = await service.call('analyze_cross_platform_interests', { focus: 'anime' });
    assert.equal(partial.status, 'partial'); assert.equal(partial.sources[0].status, 'ok'); assert.equal(partial.sources[1].source_status, 'cache_query_failed');
  } finally { f.sql.close(); }
});
test('网页登录同步验证所有者、同源和字段，Steam密钥只进入官方请求头', async () => {
  const f = fixture(); try {
    await f.store.owner('owner');
    const env = { ...f.env, STEAM_API_KEY: 'test-only-steam-key-not-real', STEAM_ID: '76561198000000000' };
    let fetched = false;
    const fetcher = (async (url: URL, init: RequestInit) => { fetched = true; assert.equal(url.hostname, 'api.steampowered.com'); assert.equal(url.searchParams.has('key'), false); assert.equal((init.headers as Record<string,string>)['x-webapi-key'], env.STEAM_API_KEY); return Response.json({ response: { game_count: 1, games: [{ appid: 123, name: 'Official game', playtime_forever: 60 }] } }); }) as unknown as typeof fetch;
    const request = (origin = 'https://site.test', body = 'platform=steam&dataset=owned_games') => new Request('https://site.test/api/sync-platform', { method: 'POST', headers: { origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    await assert.rejects(syncFromWeb(request(), null, env, fetcher), /AUTH_REQUIRED/);
    await assert.rejects(syncFromWeb(request('https://attacker.test'), 'owner', env, fetcher), /ORIGIN_DENIED/);
    await assert.rejects(syncFromWeb(request(), 'someone-else', env, fetcher), /OWNER_ONLY/);
    assert.equal(fetched, false);
    const result = await syncFromWeb(request(), 'owner', env, fetcher); assert.equal(result.records_committed, 1); assert.equal(result.has_more, false);
    const data = await f.store.query(querySchema.parse({ platform: 'steam' })); assert.equal(data.items[0].playtime_minutes, 60); assert.equal(JSON.stringify(data).includes(env.STEAM_API_KEY), false);
    await assert.rejects(syncFromWeb(request('https://site.test', 'platform=steam&platform=bilibili&dataset=owned_games'), 'owner', env, fetcher), /INVALID_ARGUMENTS/);
  } finally { f.sql.close(); }
});

test('Worker兼容的手动重定向模式不向其他主机转发凭据', async () => {
  let calls = 0;
  const redirect = (async (_url, init) => {
    calls++; assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 307, headers: { Location: 'https://attacker.test/collect' } });
  }) as typeof fetch;
  await assert.rejects(safeFetch(redirect)('https://api.steampowered.com/', { headers: { 'x-webapi-key': 'test-only-secret' }, redirect: 'follow' }), /UPSTREAM_REDIRECT_BLOCKED/);
  assert.equal(calls, 1);
  await assert.rejects(neteaseRequest('/likelist', { uid: '42' }, 'MUSIC_U=test-only-secret', redirect), /UPSTREAM_REDIRECT_BLOCKED/);
  assert.equal(calls, 2);
  const compatible = (async (_url, init) => { if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode'); return Response.json({ code: 200 }); }) as typeof fetch;
  assert.equal((await safeFetch(compatible)('https://api.bilibili.com/')).status, 200);
});
