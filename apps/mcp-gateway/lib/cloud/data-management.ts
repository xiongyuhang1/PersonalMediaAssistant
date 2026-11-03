import { z } from 'zod';
import type { CloudStore } from './store.ts';
import { platforms, platformSchema, type Platform } from './contracts.ts';
import { AppError, readCursor, signCursor } from './security.ts';

export const deletionScope = z.enum(['steam', 'bilibili', 'netease', 'dandanplay', 'all']);
const previewSchema = z.object({ scope: deletionScope }).strict();
export const deleteSchema = z.object({ scope: deletionScope, confirmation: z.string().max(40), token: z.string().min(1).max(1800) }).strict();
type Scope = z.infer<typeof deletionScope>;
const inScope = (scope: Scope) => scope === 'all' ? [...platforms] : [scope];
export async function deletionPreview(store: CloudStore, args: unknown, now = Date.now()) {
  const { scope } = previewSchema.parse(args); const sources = inScope(scope); const marks = sources.map(() => '?').join(',');
  const [counts, feedback, samples, controls] = await store.db.batch([
    store.db.prepare(`SELECT platform,COUNT(*) AS records FROM media_records WHERE platform IN (${marks}) GROUP BY platform`).bind(...sources),
    store.db.prepare(`SELECT COUNT(*) AS records FROM media_feedback WHERE platform IN (${marks})`).bind(...sources),
    store.db.prepare('SELECT COUNT(*) AS records FROM steam_playtime_samples WHERE ?').bind(sources.includes('steam') ? 1 : 0),
    store.db.prepare(`SELECT platform,sync_paused FROM platform_controls WHERE platform IN (${marks})`).bind(...sources),
  ]);
  const expires = now + 600000;
  return { schema_version: '1.0', scope, platforms: sources, records: counts.results as { platform: Platform; records: number }[], feedback_records: (feedback.results[0] as { records: number }).records, steam_sample_records: (samples.results[0] as { records: number }).records,
    currently_paused: controls.results.filter((r: any) => r.sync_paused).map((r: any) => r.platform),
    confirmation_required: `DELETE ${scope}`, token: signCursor({ kind: 'personal_deletion', scope, nonce: crypto.randomUUID(), expires }, store.secret), expires_at: new Date(expires).toISOString(),
    effects: ['删除本服务范围内的媒体缓存、反馈、时长样本和同步游标，并暂停这些平台的同步。计数为预览时的值，确认时可能变化。', '不修改平台账号、本地弹弹play数据库、已下载的备份和Sites登录凭据。', '恢复同步后可从平台或本地采集器重新导入；保留最少的删除回执和暂停设置以防重放与自动回填。'],
  };
}
export async function deletePersonalData(store: CloudStore, args: unknown, now = Date.now()) {
  const q = deleteSchema.parse(args);
  if (q.confirmation !== `DELETE ${q.scope}`) throw new AppError('DELETION_CONFIRMATION_REQUIRED');
  let token: Record<string, unknown>;
  try { token = readCursor(q.token, store.secret); } catch { throw new AppError('DELETION_TOKEN_INVALID'); }
  if (token.kind !== 'personal_deletion' || token.scope !== q.scope || typeof token.nonce !== 'string' || typeof token.expires !== 'number' || token.expires <= now || token.expires > now + 600000) throw new AppError('DELETION_TOKEN_INVALID');
  const receipt = () => store.db.prepare('SELECT scope,deleted_at FROM data_deletions WHERE id=?').bind(token.nonce).first<{ scope: string; deleted_at: string }>();
  const old = await receipt();
  const result = (duplicate: boolean, at: string) => ({ deleted: true, duplicate, scope: q.scope, deleted_at: at, paused_platforms: inScope(q.scope), source_accounts_modified: false });
  if (old) return result(true, old.deleted_at);
  const at = new Date(now).toISOString(); const sources = inScope(q.scope); const marks = sources.map(() => '?').join(',');
  const writes = [store.db.prepare('INSERT INTO data_deletions VALUES(?,?,?)').bind(token.nonce, q.scope, at)];
  for (const platform of sources) writes.push(store.db.prepare('INSERT INTO platform_controls VALUES(?,1,?,?) ON CONFLICT(platform) DO UPDATE SET sync_paused=1,sync_epoch=excluded.sync_epoch,updated_at=excluded.updated_at').bind(platform, crypto.randomUUID(), at));
  for (const table of ['media_records', 'media_feedback', 'platform_sync_state']) writes.push(store.db.prepare(`DELETE FROM ${table} WHERE platform IN (${marks})`).bind(...sources));
  if (sources.includes('steam')) writes.push(store.db.prepare('DELETE FROM steam_playtime_samples'));
  if (sources.includes('bilibili')) writes.push(store.db.prepare("DELETE FROM pma_meta WHERE key LIKE 'bili_collector:%'"));
  if (sources.includes('dandanplay')) { writes.push(store.db.prepare('DELETE FROM collector_batches')); writes.push(store.db.prepare("DELETE FROM pma_meta WHERE key='dandanplay_rating_scale'")); }
  try { await store.db.batch(writes); } catch (error) { const concurrent = await receipt(); if (concurrent) return result(true, concurrent.deleted_at); throw error; }
  return result(false, at);
}
export async function resumeSync(store: CloudStore, args: unknown) {
  const { platform } = z.object({ platform: platformSchema }).strict().parse(args);
  const old = await store.control(platform);
  if (old.sync_paused) await store.db.prepare('UPDATE platform_controls SET sync_paused=0,updated_at=? WHERE platform=?').bind(new Date().toISOString(), platform).run();
  return { platform, sync_paused: false, already_enabled: !old.sync_paused, instructions: platform === 'dandanplay' ? '本地采集器下次连接时会按云端同步代次重新上传规范化记录；本机须开机。' : '已允许同步。现在可在平台卡片或MCP中按数据集重新同步。' };
}
