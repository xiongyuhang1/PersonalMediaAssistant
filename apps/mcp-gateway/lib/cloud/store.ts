import { randomUUID } from 'node:crypto';
import { platforms, type MediaRecord, type Platform, type Dataset, type Query } from './contracts.ts';
import { AppError, hash, signCursor, readCursor } from './security.ts';
import { dandanplayRatingScale, dandanplaySummary, dandanplaySummarySql } from './dandanplay.ts';
export class CloudStore {
  constructor(public db: D1Database, public secret: string) {}
  // A condition on every write also covers a request already in flight when
  // the owner deletes data. D1 executes each bounded batch atomically.
  private active(platform: Platform, epoch?: string) { return `NOT EXISTS(SELECT 1 FROM platform_controls WHERE platform='${platform}' AND sync_paused<>0)` + (epoch ? ` AND COALESCE((SELECT sync_epoch FROM platform_controls WHERE platform='${platform}'),'initial')='${epoch}'` : ''); }
  async control(platform: Platform) {
    const row = await this.db.prepare('SELECT sync_paused,sync_epoch FROM platform_controls WHERE platform=?').bind(platform).first<{ sync_paused: number; sync_epoch: string }>();
    return { sync_paused: Boolean(row?.sync_paused), sync_epoch: row?.sync_epoch ?? 'initial' };
  }
  async assertSyncAllowed(platform: Platform) { if ((await this.control(platform)).sync_paused) throw new AppError('SYNC_PAUSED_BY_OWNER', 409); }
  async owner(userId: string) {
    if (!userId) throw new AppError('AUTH_REQUIRED', 401);
    let row = await this.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('owner_id').first<{ value: string }>();
    if (!row) { await this.db.prepare('INSERT OR IGNORE INTO pma_meta(key,value) VALUES(?,?)').bind('owner_id', userId).run(); row = await this.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('owner_id').first<{ value: string }>(); }
    if (row?.value !== userId) throw new AppError('OWNER_ONLY', 403);
  }
  async instance() {
    const old = await this.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('instance_id').first<{ value: string }>();
    if (old) return old.value;
    await this.db.prepare('INSERT OR IGNORE INTO pma_meta(key,value) VALUES(?,?)').bind('instance_id', randomUUID()).run();
    return (await this.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('instance_id').first<{ value: string }>())!.value;
  }
  state(platform: Platform, dataset: Dataset) { return this.db.prepare('SELECT * FROM platform_sync_state WHERE platform=? AND dataset=?').bind(platform, dataset).first<Record<string, any>>(); }
  private insert(record: MediaRecord, generation: string) {
    const item = { ...record };
    for (const field of ['source_time', 'collected_at', 'published_at', 'last_watched_at', 'last_local_play_at'] as const) if (item[field]) item[field] = new Date(item[field]!).toISOString();
    return this.db.prepare(`INSERT INTO media_records SELECT ?,?,?,?,?,?,?,?,? WHERE ${this.active(item.platform)} ON CONFLICT(platform,dataset,id) DO UPDATE SET content_id=excluded.content_id,title=excluded.title,source_time=excluded.source_time,collected_at=excluded.collected_at,payload=excluded.payload,generation=excluded.generation`).bind(item.platform, item.dataset, item.id, item.content_id, item.title, item.source_time ?? item.last_watched_at ?? null, item.collected_at, JSON.stringify(item), generation);
  }
  async page(platform: Platform, dataset: Dataset, items: MediaRecord[], next: unknown, generation: string, snapshot: boolean, note: string, collector?: { epoch: string; statements: D1PreparedStatement[] }) {
    await this.assertSyncAllowed(platform);
    if(collector&&!/^(initial|[0-9a-fA-F-]{36})$/.test(collector.epoch))throw new AppError('INVALID_COLLECTOR_EPOCH');
    if (collector && (await this.control(platform)).sync_epoch !== collector.epoch) throw new AppError('COLLECTOR_EPOCH_CHANGED',409);
    const active = this.active(platform, collector?.epoch);
    if (items.some(item => item.platform !== platform || item.dataset !== dataset)) throw new AppError('ADAPTER_SCOPE_MISMATCH', 502);
    if (items.length > 180) throw new AppError('SYNC_PAGE_TOO_LARGE', 502);
    // Each statement binds at most 90 parameters; the entire bounded page and
    // cursor commit in one D1 batch. No success cursor advances after a partial write.
    const done = next === undefined || next === null; const now = new Date().toISOString();
    const final: D1PreparedStatement[] = [...collector?.statements ?? []];
    for (let i = 0; i < items.length; i += 10) {
      const group = items.slice(i, i + 10).map(original => { const item = { ...original }; for (const key of ['source_time', 'collected_at', 'published_at', 'last_watched_at', 'last_local_play_at'] as const) if (item[key]) item[key] = new Date(item[key]!).toISOString(); return item; });
      const values = group.flatMap(item => [item.platform, item.dataset, item.id, item.content_id, item.title, item.source_time ?? item.last_watched_at ?? null, item.collected_at, JSON.stringify(item), generation]);
      final.push(this.db.prepare(`INSERT INTO media_records SELECT column1,column2,column3,column4,column5,column6,column7,column8,column9 FROM (VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}) WHERE ${active} ON CONFLICT(platform,dataset,id) DO UPDATE SET content_id=excluded.content_id,title=excluded.title,source_time=excluded.source_time,collected_at=excluded.collected_at,payload=excluded.payload,generation=excluded.generation`).bind(...values));
    }
    if (done && snapshot) final.push(this.db.prepare(`DELETE FROM media_records WHERE platform=? AND dataset=? AND generation<>? AND ${active}`).bind(platform, dataset, generation));
    if (done && snapshot && platform === 'steam' && dataset === 'owned_games') {
      const day = now.slice(0, 10);
      final.push(this.db.prepare(`DELETE FROM steam_playtime_samples WHERE day=? AND ${this.active('steam')}`).bind(day));
      final.push(this.db.prepare(`INSERT INTO steam_playtime_samples SELECT ?,content_id,title,CAST(json_extract(payload,'$.playtime_minutes') AS INTEGER),? FROM media_records WHERE platform='steam' AND dataset='owned_games' AND generation=? AND json_type(payload,'$.playtime_minutes') IN ('integer','real') AND ${this.active('steam')}`).bind(day, now, generation));
    }
    final.push(this.db.prepare(`INSERT INTO platform_sync_state SELECT ?,?,?,?,?,?,?,?,? WHERE ${active} ON CONFLICT(platform,dataset) DO UPDATE SET cursor=excluded.cursor,generation=excluded.generation,state=excluded.state,last_attempt=excluded.last_attempt,last_success=COALESCE(excluded.last_success,platform_sync_state.last_success),error_code=NULL,coverage_note=excluded.coverage_note`).bind(platform, dataset, done ? null : JSON.stringify(next), generation, done ? 'synced' : 'partial', now, done ? now : null, null, note));
    await this.db.batch(final);
    await this.assertSyncAllowed(platform);
    if (collector && (await this.control(platform)).sync_epoch !== collector.epoch) throw new AppError('COLLECTOR_EPOCH_CHANGED',409);
  }
  async fail(platform: Platform, dataset: Dataset, code: string) { await this.db.prepare(`INSERT INTO platform_sync_state(platform,dataset,state,last_attempt,error_code) SELECT ?,?,'failed',?,? WHERE ${this.active(platform)} ON CONFLICT(platform,dataset) DO UPDATE SET state='failed',last_attempt=excluded.last_attempt,error_code=excluded.error_code`).bind(platform, dataset, new Date().toISOString(), code).run(); }
  async status(configured: Record<Platform, boolean>) {
    const [state, counts, heartbeat, watchlist, controls] = await this.db.batch([this.db.prepare('SELECT platform,dataset,state,last_attempt AS last_attempt_at,last_success AS last_successful_sync_at,error_code,coverage_note FROM platform_sync_state ORDER BY platform,dataset'), this.db.prepare('SELECT platform,COUNT(*) AS records FROM media_records GROUP BY platform'), this.db.prepare("SELECT MAX(value) AS last_seen FROM pma_meta WHERE key LIKE 'collector_last_seen:%'"), this.db.prepare(dandanplaySummarySql), this.db.prepare('SELECT platform,sync_paused FROM platform_controls')]);
    return { schema_version: '1.0', status: 'ok', platforms: platforms.map(platform => {
      const datasets = state.results.filter((s: any) => s.platform === platform) as Record<string, any>[];
      const last = datasets.map(d => d.last_successful_sync_at as string).filter(Boolean).sort().at(-1) ?? null;
      const count = counts.results.find((r: any) => r.platform === platform) as { records: number } | undefined;
      const paused = Boolean((controls.results.find((r: any) => r.platform === platform) as { sync_paused: number } | undefined)?.sync_paused);
      return { platform, configured: configured[platform], sync_paused: paused, state: paused ? 'paused' : datasets.some(d => d.state === 'failed') ? 'failed' : datasets.some(d => d.state === 'partial') ? 'partial' : last ? 'synced' : configured[platform] ? 'not_synced' : 'not_configured', last_successful_sync_at: last, records: count?.records ?? (last || paused ? 0 : null), ...(platform === 'dandanplay' ? { collector_last_seen_at: (heartbeat.results[0] as { last_seen: string | null })?.last_seen ?? null, watchlist_summary: datasets.some(d => d.dataset === 'watchlist' && d.last_successful_sync_at) ? dandanplaySummary(watchlist.results[0] as Record<string, unknown>) : null } : {}), datasets };
    }) };
  }
  async watchlistSummary() { return dandanplaySummary((await this.db.prepare(dandanplaySummarySql).first<Record<string, unknown>>()) ?? {}); }
  async coverage(platform?: Platform, dataset?: Dataset) {
    const clauses = []; const args: string[] = [];
    if (platform) { clauses.push('platform=?'); args.push(platform); } if (dataset) { clauses.push('dataset=?'); args.push(dataset); }
    const result = await this.db.prepare(`SELECT platform,dataset,COUNT(*) AS records,MIN(source_time) AS earliest_observed_time,MAX(source_time) AS latest_observed_time,MAX(collected_at) AS last_collected_at FROM media_records ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} GROUP BY platform,dataset`).bind(...args).all();
    return { datasets: result.results, completeness: 'observed_records_only', warnings: ['观察到的日期范围不保证每天、每次重看或每台设备都有记录。'] };
  }
  async query(query: Query) {
    const { limit, cursor, ...filter } = query; const fingerprint = hash(JSON.stringify(filter));
    const clauses: string[] = []; const args: (string | number)[] = [];
    for (const key of ['platform', 'dataset'] as const) if (query[key]) { clauses.push(`${key}=?`); args.push(query[key]!); }
    if (query.keyword) { clauses.push('instr(lower(title),lower(?))>0'); args.push(query.keyword); }
    for (const key of ['uploader_id', 'category_id'] as const) if (query[key]) { clauses.push(`json_extract(payload,'$.${key}')=?`); args.push(query[key]!); }
    if (query.parent_id) { clauses.push("json_extract(payload,'$.parent_id')=?"); args.push(query.parent_id); }
    if (query.content_id) { clauses.push('content_id=?'); args.push(query.content_id); }
    if (query.following !== undefined) { clauses.push("json_extract(payload,'$.following')=?"); args.push(query.following ? 1 : 0); }
    if (query.completion_state) { clauses.push("json_extract(payload,'$.completion_state')=?"); args.push(query.completion_state); }
    if (query.user_rating !== undefined) { clauses.push("json_extract(payload,'$.user_rating')=?"); args.push(query.user_rating); }
    if (query.rating_state) { clauses.push("json_extract(payload,'$.user_rating_state')=?"); args.push(query.rating_state); }
    if (query.content_type) { clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.content_types')) WHERE value=?)"); args.push(query.content_type); }
    if (query.after) { clauses.push('source_time>=?'); args.push(new Date(query.after).toISOString()); } if (query.before) { clauses.push('source_time<?'); args.push(new Date(query.before).toISOString()); }
    if (cursor) { const c = readCursor(cursor, this.secret); if (c.filters !== fingerprint || typeof c.key !== 'string') throw new AppError('INVALID_CURSOR'); clauses.push("(platform||':'||dataset||':'||id)>?"); args.push(c.key); }
    const rows = await this.db.prepare(`SELECT payload,platform||':'||dataset||':'||id AS page_key FROM media_records ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY platform||':'||dataset||':'||id LIMIT ?`).bind(...args, limit + 1).all<{ payload: string; page_key: string }>();
    const selected: typeof rows.results = []; let bytes = 0;
    for (const row of rows.results.slice(0, limit)) { const n = new TextEncoder().encode(row.payload).length; if (selected.length && bytes + n > 12000) break; selected.push(row); bytes += n; }
    const more = rows.results.length > selected.length;
    return { schema_version: '1.0', items: selected.map(r => JSON.parse(r.payload) as MediaRecord), has_more: more, next_cursor: more && selected.length ? signCursor({ filters: fingerprint, key: selected.at(-1)!.page_key }, this.secret) : null, coverage: await this.coverage(query.platform, query.dataset) };
  }
  async ingest(batch: { device_id: string; batch_id: string; items: MediaRecord[] }) {
    await this.assertSyncAllowed('dandanplay');
    const digest = hash(JSON.stringify(batch)); const read = () => this.db.prepare('SELECT digest,received_at FROM collector_batches WHERE device_id=? AND batch_id=?').bind(batch.device_id, batch.batch_id).first<{ digest: string; received_at: string }>();
    const check = (row: { digest: string; received_at: string }) => { if (row.digest !== digest) throw new AppError('BATCH_ID_CONFLICT', 409); return { accepted: true, duplicate: true, received_at: row.received_at }; };
    const old = await read(); if (old) return check(old);
    const now = new Date().toISOString();
    const writes = [this.db.prepare(`INSERT INTO collector_batches SELECT ?,?,?,? WHERE ${this.active('dandanplay')}`).bind(batch.device_id, batch.batch_id, digest, now), ...batch.items.map(item => this.insert(item, `${batch.device_id}:${batch.batch_id}`))];
    if (batch.items.some(item => item.dataset === 'watchlist')) writes.push(this.db.prepare(`INSERT INTO pma_meta(key,value) SELECT ?,? WHERE ${this.active('dandanplay')} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind('dandanplay_rating_scale', JSON.stringify(dandanplayRatingScale)));
    for (const dataset of new Set(batch.items.map(item => item.dataset))) writes.push(this.db.prepare(`INSERT INTO platform_sync_state(platform,dataset,state,last_attempt,last_success,coverage_note) SELECT 'dandanplay',?,'synced',?,?,? WHERE ${this.active('dandanplay')} ON CONFLICT(platform,dataset) DO UPDATE SET state='synced',last_attempt=excluded.last_attempt,last_success=excluded.last_success,error_code=NULL`).bind(dataset, now, now, '已接收的本地增量；不推断未上传的记录、其他设备或无日期的完成时间。'));
    try { await this.db.batch(writes); } catch (error) { const existing = await read(); if (existing) return check(existing); throw error; }
    await this.assertSyncAllowed('dandanplay');
    return { accepted: true, duplicate: false, records: batch.items.length, received_at: now };
  }
}
