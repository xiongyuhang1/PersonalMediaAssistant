import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { type Adapter, type Platform, recordSchema, syncSchema } from './contracts.js';
import { AppError, hash } from './security.js';
import { Store } from './store.js';

export class SyncEngine {
  store: Store; adapters: Map<Platform, Adapter>; active = new Map<string, string>(); pending = new Set<Promise<void>>();
  constructor(store: Store, adapters: Adapter[]) { this.store = store; this.adapters = new Map(adapters.map(adapter => [adapter.platform, adapter])); }
  job(id: string) { const job = this.store.db.prepare('SELECT id,platform,dataset,state,created_at,finished_at,error_code,pages FROM jobs WHERE id=?').get(id); if (!job) throw new AppError('JOB_NOT_FOUND', 404); return job; }
  enqueue(input: z.infer<typeof syncSchema>) {
    const adapter = this.adapters.get(input.platform);
    if (!adapter) throw new AppError(input.platform === 'dandanplay' ? 'LOCAL_COLLECTOR_REQUIRED' : 'UNSUPPORTED', 409);
    if (!adapter.datasets.includes(input.dataset)) throw new AppError('UNSUPPORTED_DATASET');
    if (!adapter.configured) throw new AppError('AUTH_REQUIRED', 409);
    const { request_id, ...parameters } = input;
    const digest = hash(JSON.stringify(parameters));
    if (request_id) {
      const existing = this.store.db.prepare('SELECT id,request_hash FROM jobs WHERE request_id=?').get(request_id) as { id: string; request_hash: string } | undefined;
      if (existing) { if (existing.request_hash !== digest) throw new AppError('REQUEST_ID_CONFLICT', 409); return this.job(existing.id); }
    }
    const key = `${input.platform}:${input.dataset}`;
    const running = this.active.get(key); if (running) return this.job(running);
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO jobs(id,request_id,request_hash,platform,dataset,state,created_at) VALUES(?,?,?,?,?,?,?)').run(id, request_id ?? null, digest, input.platform, input.dataset, 'running', new Date().toISOString());
    this.active.set(key, id);
    const task = Promise.resolve().then(() => this.run(id, adapter, input)).finally(() => { this.active.delete(key); this.pending.delete(task); });
    this.pending.add(task);
    return this.job(id);
  }
  async drain() { await Promise.all(this.pending); }
  private async run(id: string, adapter: Adapter, input: z.infer<typeof syncSchema>) {
    let pages = 0;
    try {
      const saved = this.store.state(input.platform, input.dataset);
      let cursor: unknown = !input.restart_cursor && saved?.cursor ? JSON.parse(saved.cursor) : undefined;
      const generation = cursor !== undefined && saved?.generation ? saved.generation as string : randomUUID();
      this.store.markAttempt(input.platform, input.dataset);
      do {
        const page = await adapter.page(input.dataset, cursor);
        const parsed = recordSchema.array().safeParse(page.items);
        if (!parsed.success) throw new AppError('UPSTREAM_CHANGED', 502);
        this.store.commitPage(input.platform, input.dataset, parsed.data, page.next_cursor, generation, page.snapshot, page.coverage_note ?? '仅覆盖本次已读取的数据。');
        pages++; cursor = page.next_cursor;
      } while (cursor !== undefined && cursor !== null && pages < input.max_pages);
      this.store.db.prepare('UPDATE jobs SET state=?,finished_at=?,pages=? WHERE id=?').run(cursor !== undefined && cursor !== null ? 'partial' : 'succeeded', new Date().toISOString(), pages, id);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'SYNC_FAILED';
      this.store.fail(input.platform, input.dataset, code);
      this.store.db.prepare("UPDATE jobs SET state='failed',error_code=?,finished_at=?,pages=? WHERE id=?").run(code, new Date().toISOString(), pages, id);
    }
  }
}
