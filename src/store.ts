import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { platforms, type Platform, type Dataset, type MediaRecord, type Query } from './contracts.js';
import { AppError, hash, readCursor, signCursor } from './security.js';

export class Store {
  db: DatabaseSync;
  secret: string;
  constructor(path: string, secret: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.secret = secret;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(platform TEXT NOT NULL,dataset TEXT NOT NULL,id TEXT NOT NULL,content_id TEXT NOT NULL,title TEXT NOT NULL,source_time TEXT,collected_at TEXT NOT NULL,payload TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(platform,dataset,id));
      CREATE INDEX IF NOT EXISTS records_page ON records(platform,dataset,source_time DESC,id);
      CREATE TABLE IF NOT EXISTS sync_state(platform TEXT NOT NULL,dataset TEXT NOT NULL,cursor TEXT,generation TEXT,state TEXT NOT NULL,last_attempt TEXT,last_success TEXT,last_page TEXT,error_code TEXT,coverage_note TEXT,PRIMARY KEY(platform,dataset));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,request_hash TEXT NOT NULL,platform TEXT NOT NULL,dataset TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,error_code TEXT,pages INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ingest_batches(device_id TEXT NOT NULL,batch_id TEXT NOT NULL,digest TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(device_id,batch_id));
      CREATE TABLE IF NOT EXISTS feedback(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,platform TEXT NOT NULL,content_id TEXT NOT NULL,feedback TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('instance_id', randomUUID());
    this.db.exec("UPDATE jobs SET state='interrupted',error_code='PROCESS_RESTARTED' WHERE state='running'; UPDATE sync_state SET state='partial',error_code='PROCESS_RESTARTED' WHERE state='running'");
  }
  close() { this.db.close(); }
  instanceId() { return (this.db.prepare("SELECT value FROM settings WHERE key='instance_id'").get() as { value: string }).value; }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  state(platform: Platform, dataset: Dataset) { return this.db.prepare('SELECT * FROM sync_state WHERE platform=? AND dataset=?').get(platform, dataset) as Record<string, any> | undefined; }
  upsert(items: MediaRecord[], generation: string) {
    const insert = this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,dataset,id) DO UPDATE SET content_id=excluded.content_id,title=excluded.title,source_time=excluded.source_time,collected_at=excluded.collected_at,payload=excluded.payload,generation=excluded.generation');
    for (const original of items) {
      const item = { ...original };
      for (const field of ['source_time', 'collected_at', 'published_at', 'last_watched_at'] as const) if (item[field]) item[field] = new Date(item[field]!).toISOString();
      insert.run(item.platform, item.dataset, item.id, item.content_id, item.title, item.source_time ?? item.last_watched_at ?? null, item.collected_at, JSON.stringify(item), generation);
    }
  }
  commitPage(platform: Platform, dataset: Dataset, items: MediaRecord[], cursor: unknown, generation: string, snapshot: boolean, note: string) {
    this.transaction(() => {
      if (items.some(item => item.platform !== platform || item.dataset !== dataset)) throw new AppError('ADAPTER_SCOPE_MISMATCH', 502);
      this.upsert(items, generation);
      const finished = cursor === undefined || cursor === null;
      if (finished && snapshot) this.db.prepare('DELETE FROM records WHERE platform=? AND dataset=? AND generation<>?').run(platform, dataset, generation);
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO sync_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,dataset) DO UPDATE SET cursor=excluded.cursor,generation=excluded.generation,state=excluded.state,last_attempt=excluded.last_attempt,last_success=COALESCE(excluded.last_success,sync_state.last_success),last_page=excluded.last_page,error_code=NULL,coverage_note=excluded.coverage_note').run(platform, dataset, finished ? null : JSON.stringify(cursor), generation, finished ? 'synced' : 'partial', now, finished ? now : null, now, null, note);
    });
  }
  markAttempt(platform: Platform, dataset: Dataset) {
    this.db.prepare("INSERT INTO sync_state(platform,dataset,state,last_attempt) VALUES(?,?,'running',?) ON CONFLICT(platform,dataset) DO UPDATE SET state='running',last_attempt=excluded.last_attempt,error_code=NULL").run(platform, dataset, new Date().toISOString());
  }
  fail(platform: Platform, dataset: Dataset, code: string) { this.db.prepare("UPDATE sync_state SET state='failed',error_code=? WHERE platform=? AND dataset=?").run(code, platform, dataset); }
  coverage(platform?: Platform, dataset?: Dataset) {
    const args: string[] = []; const clauses: string[] = [];
    if (platform) { clauses.push('platform=?'); args.push(platform); }
    if (dataset) { clauses.push('dataset=?'); args.push(dataset); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT platform,dataset,COUNT(*) AS records,MIN(source_time) AS earliest_observed_time,MAX(source_time) AS latest_observed_time,MAX(collected_at) AS last_collected_at FROM records ${where} GROUP BY platform,dataset`).all(...args);
    return { datasets: rows, completeness: 'observed_records_only', warnings: ['最早/最晚观察值不证明其间全部行为或全部设备均被覆盖。'] };
  }
  status(configured: Record<Platform, boolean>) {
    return { schema_version: '1.0', status: 'ok', platforms: platforms.map(platform => {
      const datasets = this.db.prepare('SELECT dataset,state,last_attempt AS last_attempt_at,last_success AS last_successful_sync_at,last_page AS last_page_committed_at,error_code,coverage_note FROM sync_state WHERE platform=? ORDER BY dataset').all(platform) as Record<string, any>[];
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE platform=?').get(platform) as { n: number }).n;
      const success = datasets.map(d => d.last_successful_sync_at as string).filter(Boolean).sort().at(-1) ?? null;
      const state = datasets.some(d => d.state === 'running') ? 'syncing' : datasets.some(d => d.state === 'failed') ? 'failed' : datasets.some(d => d.state === 'partial') ? 'partial' : success ? 'synced' : configured[platform] ? 'not_synced' : 'not_configured';
      return { platform, configured: configured[platform], state, last_successful_sync_at: success, records: datasets.length || count ? count : null, datasets };
    }) };
  }
  query(query: Query) {
    const { limit, cursor, ...filters } = query;
    const fingerprint = hash(JSON.stringify(filters));
    const clauses: string[] = []; const args: Array<string | number> = [];
    for (const field of ['platform', 'dataset'] as const) if (query[field]) { clauses.push(`${field}=?`); args.push(query[field]!); }
    if (query.keyword) { clauses.push("instr(lower(title),lower(?))>0"); args.push(query.keyword); }
    for (const field of ['uploader_id', 'category_id'] as const) if (query[field]) { clauses.push(`json_extract(payload,'$.${field}')=?`); args.push(query[field]!); }
    if (query.content_type) { clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.content_types')) WHERE value=?)"); args.push(query.content_type); }
    if (query.after) { clauses.push('source_time>=?'); args.push(new Date(query.after).toISOString()); }
    if (query.before) { clauses.push('source_time<?'); args.push(new Date(query.before).toISOString()); }
    if (cursor) {
      const value = readCursor(cursor, this.secret);
      if (value.filters !== fingerprint || typeof value.key !== 'string') throw new AppError('INVALID_CURSOR');
      clauses.push("(platform||':'||dataset||':'||id)>?"); args.push(value.key);
    }
    const rows = this.db.prepare(`SELECT payload,platform||':'||dataset||':'||id AS page_key FROM records ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY platform||':'||dataset||':'||id LIMIT ?`).all(...args, limit + 1) as { payload: string; page_key: string }[];
    const more = rows.length > limit; const page = rows.slice(0, limit);
    return { schema_version: '1.0', items: page.map(r => JSON.parse(r.payload) as MediaRecord), next_cursor: more ? signCursor({ key: page.at(-1)!.page_key, filters: fingerprint }, this.secret) : null, has_more: more, coverage: this.coverage(query.platform, query.dataset) };
  }
  ingest(batch: { device_id: string; batch_id: string; items: MediaRecord[] }) {
    const digest = hash(JSON.stringify(batch));
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT digest,received_at FROM ingest_batches WHERE device_id=? AND batch_id=?').get(batch.device_id, batch.batch_id) as { digest: string; received_at: string } | undefined;
      if (existing) { if (existing.digest !== digest) throw new AppError('BATCH_ID_CONFLICT', 409); return { accepted: true, duplicate: true, received_at: existing.received_at }; }
      const now = new Date().toISOString();
      this.upsert(batch.items, `${batch.device_id}:${batch.batch_id}`);
      this.db.prepare('INSERT INTO ingest_batches VALUES(?,?,?,?)').run(batch.device_id, batch.batch_id, digest, now);
      for (const dataset of new Set(batch.items.map(item => item.dataset))) this.db.prepare("INSERT INTO sync_state(platform,dataset,state,last_attempt,last_success,last_page,coverage_note) VALUES('dandanplay',?,'synced',?,?,?,?) ON CONFLICT(platform,dataset) DO UPDATE SET state='synced',last_attempt=excluded.last_attempt,last_success=excluded.last_success,last_page=excluded.last_page,error_code=NULL").run(dataset, now, now, now, '本地增量推送；仅覆盖已接收记录；不推断未收到的删除或其他设备状态。');
      return { accepted: true, duplicate: false, received_at: now, records: batch.items.length };
    });
  }
  feedback(value: { request_id: string; platform: Platform; content_id: string; feedback: string; reason?: string }) {
    const digest = hash(JSON.stringify(value));
    const existing = this.db.prepare('SELECT digest FROM feedback WHERE request_id=?').get(value.request_id) as { digest: string } | undefined;
    if (existing) { if (existing.digest !== digest) throw new AppError('REQUEST_ID_CONFLICT', 409); return { saved: true, duplicate: true }; }
    this.db.prepare('INSERT INTO feedback VALUES(?,?,?,?,?,?,?)').run(value.request_id, digest, value.platform, value.content_id, value.feedback, value.reason ?? null, new Date().toISOString());
    return { saved: true, duplicate: false, source_account_modified: false };
  }
}
