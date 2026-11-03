import { z } from 'zod';
import { CloudStore } from './store.ts';
import { platformSchema, recordSchema } from './contracts.ts';
import { AppError, hash, readCursor, signCursor } from './security.ts';
import { dandanplayRatingScale } from './dandanplay.ts';

export const siteOrigin = 'https://your-site.example.invalid';
export const exportSchema = z.object({ platform: platformSchema.optional(), cursor: z.string().max(1800).optional(), max_records: z.coerce.number().int().min(1).max(2000).default(2000) }).strict();
type ExportInput = z.infer<typeof exportSchema>;
type Position = { kind: 'personal_export'; scope: string; stage: 'records' | 'feedback' | 'steam_samples'; key: string };
function position(store: CloudStore, input: ExportInput): Position {
  const scope = hash(JSON.stringify({ platform: input.platform ?? null }));
  if (!input.cursor) return { kind: 'personal_export', scope, stage: 'records', key: '' };
  const value = readCursor(input.cursor, store.secret);
  if (value.kind !== 'personal_export' || value.scope !== scope || !['records', 'feedback', 'steam_samples'].includes(String(value.stage)) || typeof value.key !== 'string' || value.stage === 'steam_samples' && input.platform && input.platform !== 'steam') throw new AppError('INVALID_CURSOR');
  return value as Position;
}
export function exportDescriptor(store: CloudStore, args: unknown) {
  const input = exportSchema.parse(args); position(store, input);
  const url = new URL('/api/export', siteOrigin);
  if (input.platform) url.searchParams.set('platform', input.platform);
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  url.searchParams.set('max_records', String(input.max_records));
  return { schema_version: '1.0', status: 'ok', download_url: url.toString(), format: 'jsonl', authentication: 'same_chatgpt_account', max_records_per_file: input.max_records, instructions: '在同一账号登录的浏览器打开下载链接。文件末行提供 complete 和 next_download_url；有续页时继续下载。凭据、原始数据库和本地路径不导出。' };
}
export async function* exportLines(store: CloudStore, args: unknown): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const input = exportSchema.parse(args); let next: Position | null = position(store, input); let count = 0;
  yield { type: 'manifest', schema_version: '1.0', exported_at: new Date().toISOString(), platform: input.platform ?? 'all', consistency: 'paged_read_not_transactional', coverage: await store.coverage(input.platform), ...(!input.platform || input.platform === 'dandanplay' ? { rating_scale: dandanplayRatingScale } : {}) };
  while (next && count < input.max_records) {
    const amount = Math.min(200, input.max_records - count);
    const where: string[] = []; const params: (string | number)[] = [];
    if (input.platform && next.stage !== 'steam_samples') { where.push('platform=?'); params.push(input.platform); }
    const keyExpression = next.stage === 'records' ? "platform||':'||dataset||':'||id" : next.stage === 'feedback' ? 'request_id' : "day||':'||content_id";
    if (next.key) { where.push(`${keyExpression}>?`); params.push(next.key); }
    const columns: string = next.stage === 'records' ? 'payload' : next.stage === 'feedback' ? 'request_id,platform,content_id,feedback,reason,created_at' : 'day,content_id,title,playtime_minutes,captured_at';
    const table = next.stage === 'records' ? 'media_records' : next.stage === 'feedback' ? 'media_feedback' : 'steam_playtime_samples';
    const result: D1Result<Record<string, unknown>> = await store.db.prepare(`SELECT ${columns},${keyExpression} AS page_key FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${keyExpression} LIMIT ?`).bind(...params, amount + 1).all<Record<string, unknown>>();
    const selected: Array<Record<string, unknown>> = result.results.slice(0, amount);
    for (const row of selected) {
      if (next.stage === 'records') {
        const parsed = recordSchema.safeParse(JSON.parse(String(row.payload)));
        if (!parsed.success) throw new AppError('EXPORT_RECORD_INVALID', 500);
        yield { type: 'record', record: parsed.data };
      } else if (next.stage === 'feedback') {
        yield { type: 'feedback', feedback: { request_id: row.request_id, platform: row.platform, content_id: row.content_id, feedback: row.feedback, reason: row.reason, created_at: row.created_at } };
      } else {
        yield { type: 'steam_playtime_sample', sample: { platform: 'steam', day_utc: row.day, content_id: row.content_id, title: row.title, cumulative_minutes: row.playtime_minutes, captured_at: row.captured_at } };
      }
      count++;
    }
    if (result.results.length > amount) next = { ...next, key: String(selected.at(-1)!.page_key) };
    else next = next.stage === 'records' ? { ...next, stage: 'feedback', key: '' } : next.stage === 'feedback' && (!input.platform || input.platform === 'steam') ? { ...next, stage: 'steam_samples', key: '' } : null;
  }
  const cursor = next ? signCursor(next, store.secret) : null;
  yield { type: 'end', records_in_file: count, complete: !next, next_cursor: cursor, next_download_url: cursor ? exportDescriptor(store, { ...input, cursor }).download_url : null };
}
export async function exportResponse(store: CloudStore, userId: string | null, args: unknown) {
  if (!userId) throw new AppError('AUTH_REQUIRED', 401);
  await store.owner(userId);
  const input = exportSchema.parse(args); position(store, input);
  const iterator = exportLines(store, input); const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const row = await iterator.next(); if (row.done) controller.close(); else controller.enqueue(encoder.encode(JSON.stringify(row.value) + '\n')); }
      catch (error) { controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', code: error instanceof AppError ? error.code : 'EXPORT_FAILED', complete: false }) + '\n')); controller.close(); }
    },
    async cancel() { await iterator.return(undefined); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="personal-media-${input.platform ?? 'all'}-${Date.now()}.jsonl"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
}
