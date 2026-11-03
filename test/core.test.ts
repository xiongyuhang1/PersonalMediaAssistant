import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AppError } from '../src/security.js';
import { querySchema, recordSchema, syncSchema, ingestSchema, type Adapter, type MediaRecord } from '../src/contracts.js';
import { SyncEngine } from '../src/sync.js';
import { createApp } from '../src/server.js';
import { SteamAdapter, mapNeteaseRanking, mapNeteaseRecent } from '../src/adapters.js';
const secret = 'test-only-cursor-key-not-a-production-secret';
const admin = 'test-only-service-token-not-a-production-secret';
const collector = 'test-only-collector-token-different-from-service';
const sample = (id: string, extra: Partial<MediaRecord> = {}): MediaRecord => recordSchema.parse({ id, content_id: id, platform: 'dandanplay', dataset: 'history', title: `Anime ${id}`, record_kind: 'last_watch_observation', collected_at: '2026-11-02T00:00:00Z', ...extra });

test('完成但无观看日期：保留明确完成状态，不创造事件时间', () => {
  const value = sample('anime-complete', { dataset: 'watchlist', record_kind: 'completion_assertion', completion_state: 'completed', completion_basis: 'explicit_source_status', all_episodes_completed: true, last_watched_at: null });
  assert.equal(value.last_watched_at, null);
  assert.equal(value.source_time, undefined);
  assert.throws(() => sample('bad', { all_episodes_completed: true }));
});

test('增量导入严格白名单：不接收绝对路径或 Cookie，也不接收其他平台', () => {
  const base = { schema_version: '1.0', device_id: 'windows-primary', batch_id: 'batch-0001', items: [sample('episode')] };
  assert.equal(ingestSchema.safeParse(base).success, true);
  assert.equal(ingestSchema.safeParse({ ...base, items: [{ ...base.items[0], FilePath: 'C:/private/media.mkv' }] }).success, false);
  assert.equal(ingestSchema.safeParse({ ...base, cookie: 'not-allowed' }).success, false);
  assert.equal(ingestSchema.safeParse({ ...base, items: [sample('steam', { platform: 'steam' })] }).success, false);
});

test('批次幂等及 ID 冲突不会重复记录或改写源状态', () => {
  const store = new Store(':memory:', secret);
  try {
    const batch = { device_id: 'windows-primary', batch_id: 'batch-0001', items: [sample('episode')] };
    assert.equal(store.ingest(batch).duplicate, false);
    assert.equal(store.ingest(batch).duplicate, true);
    assert.throws(() => store.ingest({ ...batch, items: [sample('different')] }), (e: unknown) => e instanceof AppError && e.code === 'BATCH_ID_CONFLICT');
    assert.equal(store.query(querySchema.parse({})).items.length, 1);
  } finally { store.close(); }
});

test('先过滤再分页，游标防篡改且不能换过滤器', () => {
  const store = new Store(':memory:', secret);
  try {
    store.transaction(() => store.upsert(Array.from({ length: 55 }, (_, i) => sample(String(i).padStart(3, '0'), { title: i % 2 ? 'unrelated' : 'OST target' })), 'test'));
    const query = { keyword: 'target', limit: 10 };
    const first = store.query(querySchema.parse(query));
    assert.equal(first.items.length, 10); assert.equal(first.has_more, true);
    const second = store.query(querySchema.parse({ ...query, cursor: first.next_cursor }));
    assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 20);
    assert.throws(() => store.query(querySchema.parse({ keyword: 'unrelated', cursor: first.next_cursor })), /INVALID_CURSOR/);
    assert.throws(() => store.query(querySchema.parse({ ...query, cursor: `${first.next_cursor}tamper` })), /INVALID_CURSOR/);
    assert.throws(() => querySchema.parse({ limit: 100000 }));
  } finally { store.close(); }
});

test('不同时区输入先规范为 UTC，日期过滤不以采集时间代替观看时间', () => {
  const store = new Store(':memory:', secret);
  try {
    store.upsert([sample('dated', { source_time: '2026-11-02T08:00:00+08:00' }), sample('undated')], 'test');
    const page = store.query(querySchema.parse({ after: '2026-11-02T00:00:00Z', before: '2026-11-02T01:00:00Z' }));
    assert.deepEqual(page.items.map(i => i.id), ['dated']);
    assert.equal(page.items[0].source_time, '2026-11-02T00:00:00.000Z');
  } finally { store.close(); }
});

test('同步失败不推进游标，其他平台仍能完成', async () => {
  const store = new Store(':memory:', secret);
  try {
    let step = 0;
    const failing: Adapter = { platform: 'bilibili', configured: true, datasets: ['history'], page: async () => {
      if (step++ === 0) return { snapshot: false, items: [sample('bv', { platform: 'bilibili' })], next_cursor: { page: 2 } };
      throw new AppError('AUTH_EXPIRED', 502);
    } };
    const good: Adapter = { platform: 'steam', configured: true, datasets: ['owned_games'], page: async () => ({ snapshot: true, items: [sample('app', { platform: 'steam', dataset: 'owned_games', record_kind: 'library_snapshot' })] }) };
    const engine = new SyncEngine(store, [failing, good]);
    const failed = engine.enqueue(syncSchema.parse({ platform: 'bilibili', dataset: 'history', max_pages: 2 }));
    const succeeded = engine.enqueue(syncSchema.parse({ platform: 'steam', dataset: 'owned_games' }));
    await engine.drain();
    assert.equal(engine.job(failed.id as string).state, 'failed');
    assert.deepEqual(JSON.parse(store.state('bilibili', 'history')!.cursor), { page: 2 });
    assert.equal(store.state('bilibili', 'history')!.last_success, null);
    assert.equal(engine.job(succeeded.id as string).state, 'succeeded');
  } finally { store.close(); }
});

test('分页快照直到完整提交才清除旧项，续传沿用同一代', async () => {
  const store = new Store(':memory:', secret);
  try {
    store.upsert([sample('old', { platform: 'steam', dataset: 'owned_games' })], 'old');
    const adapter: Adapter = { platform: 'steam', configured: true, datasets: ['owned_games'], page: async (_dataset, cursor) => ({ snapshot: true, items: [sample(cursor ? 'new-2' : 'new-1', { platform: 'steam', dataset: 'owned_games' })], next_cursor: cursor ? undefined : { page: 2 } }) };
    const engine = new SyncEngine(store, [adapter]);
    engine.enqueue(syncSchema.parse({ platform: 'steam', dataset: 'owned_games', max_pages: 1 })); await engine.drain();
    assert.equal(store.query(querySchema.parse({ platform: 'steam' })).items.length, 2);
    engine.enqueue(syncSchema.parse({ platform: 'steam', dataset: 'owned_games', max_pages: 1 })); await engine.drain();
    assert.deepEqual(store.query(querySchema.parse({ platform: 'steam' })).items.map(i => i.id), ['new-1', 'new-2']);
  } finally { store.close(); }
});

test('范围不匹配的整页事务回滚，不能跨平台注入', () => {
  const store = new Store(':memory:', secret);
  try {
    assert.throws(() => store.commitPage('steam', 'owned_games', [sample('wrong-platform')], undefined, 'gen', true, 'test'), /ADAPTER_SCOPE_MISMATCH/);
    assert.equal(store.query(querySchema.parse({})).items.length, 0);
    assert.equal(store.state('steam', 'owned_games'), undefined);
  } finally { store.close(); }
});

test('网易云 score 不伪装次数，updateTime 不伪装播放事件', () => {
  const rows = mapNeteaseRanking([{ song: { id: 1, name: 'Song', ar: [] }, score: 100 }], 'user_record_all');
  assert.equal(rows[0].rank_score, 100); assert.equal(rows[0].play_count, undefined); assert.equal(rows[0].source_time, undefined);
  const recent = mapNeteaseRecent([{ data: { id: 1, name: 'Song' }, updateTime: 1793577600000 }]);
  assert.equal(recent[0].record_kind, 'recent_play_list_item'); assert.equal(recent[0].source_time, undefined);
});

test('Steam 隐私/畸形响应不表示空游戏库；只接受明确零项', async () => {
  const config = { steamKey: 'fake-test-key', steamId: '76561198000000000' };
  const hidden = new SteamAdapter(config, (async () => Response.json({ response: {} })) as typeof fetch);
  await assert.rejects(hidden.page('owned_games'), /PERMISSION_OR_DATA_UNAVAILABLE/);
  const empty = new SteamAdapter(config, (async () => Response.json({ response: { game_count: 0 } })) as typeof fetch);
  assert.deepEqual((await empty.page('owned_games')).items, []);
});

test('实例 ID 与数据持久化在重启后仍保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pma-test-'));
  try {
    const path = join(directory, 'data.sqlite'); const first = new Store(path, secret); const id = first.instanceId();
    first.upsert([sample('persistent')], 'test'); first.close();
    const second = new Store(path, secret);
    try { assert.equal(second.instanceId(), id); assert.equal(second.query(querySchema.parse({})).items.length, 1); } finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP 设备令牌不能读历史，只能写自己的弹弹play批次；错误不含秘密', async () => {
  const store = new Store(':memory:', secret);
  const app = createApp({ store, adapters: [], serviceToken: admin, collectorToken: collector, collectorDeviceId: 'windows-primary' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/v1/records`, { headers: { Authorization: `Bearer ${collector}` } })).status, 401);
    const health = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${admin}` } }); assert.equal(health.status, 200);
    const batch = { schema_version: '1.0', device_id: 'other-device', batch_id: 'batch-0001', items: [sample('first')] };
    const push = (payload: unknown) => fetch(`${base}/v1/ingest/dandanplay`, { method: 'POST', headers: { Authorization: `Bearer ${collector}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal((await push(batch)).status, 403);
    assert.equal((await push({ ...batch, device_id: 'windows-primary' })).status, 200);
    const malformed = await push({ ...batch, Cookie: 'sensitive-cookie-value' }); const result = await malformed.text(); assert.equal(malformed.status, 400); assert.equal(result.includes('sensitive-cookie-value'), false);
    const status = await (await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${admin}` } })).json() as any;
    assert.equal(status.platforms.find((p: any) => p.platform === 'steam').records, null);
    assert.equal(status.platforms.find((p: any) => p.platform === 'dandanplay').records, 1);
  } finally { app.server.close(); app.server.closeAllConnections(); await app.sync.drain(); store.close(); }
});
