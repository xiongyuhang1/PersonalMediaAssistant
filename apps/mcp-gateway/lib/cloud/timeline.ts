import { z } from 'zod';
import type { CloudStore } from './store.ts';
import { platforms, recordSchema, type MediaRecord } from './contracts.ts';
import { AppError, hash, readCursor, signCursor } from './security.ts';

export const timelineLanes = ['last_observation', 'collection', 'platform_interaction', 'unverified_recent_list', 'collection_snapshot', 'ranking_snapshot', 'library_sample'] as const;
export const timelineLabels: Record<(typeof timelineLanes)[number], string> = {
  last_observation: '最后观看或播放观察', collection: '有日期的收藏', platform_interaction: '有日期的点赞或投币', unverified_recent_list: '最近列表时间（待核对）',
  collection_snapshot: '当前状态的采集快照', ranking_snapshot: '排行的采集快照', library_sample: 'Steam每日累计时长快照',
};
const date = z.iso.datetime({ offset: true });
export const timelineSchema = z.object({
  after: date, before: date,
  platforms: z.array(z.enum(platforms)).min(1).max(4).optional(),
  lanes: z.array(z.enum(timelineLanes)).min(1).max(7).optional(),
  keyword: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1800).optional(),
}).strict().refine(q => Date.parse(q.after) < Date.parse(q.before), 'Invalid date range');

// The fallback dates below always go into a snapshot lane. A collection or
// completion state without a date must never become a dated viewing event.
const timelineSql = `WITH valid AS (
  SELECT platform,dataset,id,content_id,title,source_time,collected_at,payload FROM media_records WHERE json_valid(payload)
), classified AS (
  SELECT *,CASE
    WHEN json_extract(payload,'$.record_kind') IN ('last_watch_observation','last_play_observation') AND json_extract(payload,'$.source_time_semantics') IN ('last_watch','last_play') AND source_time IS NOT NULL THEN 'last_observation'
    WHEN json_extract(payload,'$.record_kind')='collection_state' AND json_extract(payload,'$.source_time_semantics')='collection_time' AND source_time IS NOT NULL THEN 'collection'
    WHEN json_extract(payload,'$.record_kind')='interaction_state' AND json_extract(payload,'$.source_time_semantics') IN ('like_time','coin_time') AND source_time IS NOT NULL THEN 'platform_interaction'
    WHEN json_extract(payload,'$.record_kind')='recent_play_list_item' AND json_extract(payload,'$.source_time_semantics')='recent_list_time_unverified' AND source_time IS NOT NULL THEN 'unverified_recent_list'
    WHEN json_extract(payload,'$.record_kind') IN ('collection_state','interaction_state','completion_assertion') THEN 'collection_snapshot'
    WHEN json_extract(payload,'$.record_kind') IN ('lifetime_ranking','period_statistic') THEN 'ranking_snapshot'
    ELSE NULL END AS lane FROM valid
), timeline AS (
  SELECT platform,dataset,id,content_id,title,payload,lane,CASE WHEN lane IN ('last_observation','collection','platform_interaction','unverified_recent_list') THEN source_time ELSE collected_at END AS at,
    platform||':'||dataset||':'||id AS page_key FROM classified WHERE lane IS NOT NULL
  UNION ALL
  SELECT 'steam','owned_games','daily:'||day,'daily:'||day,'Steam每日累计时长快照',
    json_object('sampled_games',COUNT(*),'cumulative_minutes',SUM(playtime_minutes),'sample_day_utc',day),
    'library_sample',MAX(captured_at),'steam:sample:'||day FROM steam_playtime_samples GROUP BY day
)`;
type TimelineRow = { platform: string; dataset: string; id: string; content_id: string; title: string; payload: string; lane: (typeof timelineLanes)[number]; at: string; page_key: string };
type TimelineItem = { platform: string; dataset: string; content_id: string; title: string; at: string; lane: (typeof timelineLanes)[number]; time_meaning: string; collected_at?: string; parent_id?: string; completion_state?: string; all_episodes_completed?: boolean; sampled_games?: number; cumulative_minutes?: number; sample_day_utc?: string; artists?: string[] };
function itemFromRow(row: TimelineRow): TimelineItem | null {
  const base: TimelineItem = { platform: row.platform, dataset: row.dataset, content_id: row.content_id, title: row.title.slice(0, 240), at: row.at, lane: row.lane, time_meaning: timelineLabels[row.lane] };
  if (row.lane === 'library_sample') return { ...base, ...JSON.parse(row.payload) };
  const parsed = recordSchema.safeParse(JSON.parse(row.payload)); if (!parsed.success) return null;
  const r: MediaRecord = parsed.data;
  return { ...base, collected_at: r.collected_at, ...(r.parent_id ? { parent_id: r.parent_id } : {}), ...(r.completion_state ? { completion_state: r.completion_state, all_episodes_completed: r.all_episodes_completed } : {}), ...(r.artists?.length ? { artists: r.artists.slice(0, 3) } : {}) };
}
export async function crossPlatformTimeline(store: CloudStore, args: unknown) {
  const input = timelineSchema.parse(args);
  const selectedPlatforms = [...new Set(input.platforms ?? platforms)].sort(); const lanes = [...new Set(input.lanes ?? timelineLanes)].sort();
  const filter = { after: new Date(input.after).toISOString(), before: new Date(input.before).toISOString(), platforms: selectedPlatforms, lanes, keyword: input.keyword ?? '' };
  const fingerprint = hash(JSON.stringify(filter));
  const clauses = ['at>=?', 'at<?', `platform IN (${selectedPlatforms.map(() => '?').join(',')})`, `lane IN (${lanes.map(() => '?').join(',')})`];
  const values: (string | number)[] = [filter.after, filter.before, ...selectedPlatforms, ...lanes];
  if (input.keyword) { clauses.push('instr(lower(title),lower(?))>0'); values.push(input.keyword); }
  const baseWhere = clauses.join(' AND '); const summaryValues = [...values];
  if (input.cursor) {
    const c = readCursor(input.cursor, store.secret);
    if (c.kind !== 'timeline' || c.filters !== fingerprint || typeof c.at !== 'string' || typeof c.key !== 'string') throw new AppError('INVALID_CURSOR');
    clauses.push('(at<? OR (at=? AND page_key>?))'); values.push(c.at, c.at, c.key);
  }
  const [rows, totals, sourceStates] = await store.db.batch([
    store.db.prepare(`${timelineSql} SELECT * FROM timeline WHERE ${clauses.join(' AND ')} ORDER BY at DESC,page_key LIMIT ?`).bind(...values, input.limit + 1),
    store.db.prepare(`${timelineSql} SELECT lane,COUNT(*) AS records FROM timeline WHERE ${baseWhere} GROUP BY lane`).bind(...summaryValues),
    store.db.prepare(`SELECT platform,dataset,state,last_success AS last_successful_sync_at,error_code FROM platform_sync_state WHERE platform IN (${selectedPlatforms.map(() => '?').join(',')}) ORDER BY platform,dataset`).bind(...selectedPlatforms),
  ]);
  const items: TimelineItem[] = []; let consumed: TimelineRow | undefined; let bytes = 0, invalid = 0, scanned = 0;
  for (const row of (rows.results as TimelineRow[]).slice(0, input.limit)) {
    const item = itemFromRow(row); const size = item ? new TextEncoder().encode(JSON.stringify(item)).length : 0;
    if (items.length && bytes + size > 10500) break;
    consumed = row; scanned++; if (!item) { invalid++; continue; } items.push(item); bytes += size;
  }
  const more = rows.results.length > scanned;
  return {
    schema_version: '1.0', status: invalid || selectedPlatforms.some(p => !sourceStates.results.some((s: any) => s.platform === p && s.state === 'synced')) || sourceStates.results.some((s: any) => s.state !== 'synced') ? 'partial' : 'ok', range: { after: filter.after, before: filter.before, end_exclusive: true },
    items, lane_totals: totals.results, invalid_records_skipped: invalid, has_more: more,
    next_cursor: more && consumed ? signCursor({ kind: 'timeline', filters: fingerprint, at: consumed.at, key: consumed.page_key }, store.secret) : null,
    sources: selectedPlatforms.map(platform => ({ platform, datasets: sourceStates.results.filter((s: any) => s.platform === platform), coverage: 'observed_cache_only' })),
    warnings: ['最后观察不等于每次播放事件；无日期的已看完只在采集快照轨道显示。', '网易云最近列表时间尚未证实为独立播放事件；排行日期是采集时间。', 'Steam快照仅从部署后的完整游戏库同步开始按UTC日保留，不还原此前游戏会话。', '当前收藏、追番与排行是最新状态，不是持续保存的历史快照；分页期间同步可能使结果变化。'],
  };
}

export const playtimeSchema = z.object({ app_id: z.string().regex(/^\d{1,20}$/), after: date.optional(), before: date.optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1800).optional() }).strict().refine(q => !q.after || !q.before || Date.parse(q.after) < Date.parse(q.before), 'Invalid date range');
export async function steamPlaytimeHistory(store: CloudStore, args: unknown) {
  const q = playtimeSchema.parse(args); const filters = hash(JSON.stringify({ app_id: q.app_id, after: q.after ? new Date(q.after).toISOString() : null, before: q.before ? new Date(q.before).toISOString() : null }));
  const where = ['1=1']; const values: (string | number)[] = [q.app_id];
  if (q.after) { where.push('captured_at>=?'); values.push(new Date(q.after).toISOString()); } if (q.before) { where.push('captured_at<?'); values.push(new Date(q.before).toISOString()); }
  if (q.cursor) { const c = readCursor(q.cursor, store.secret); if (c.kind !== 'steam_samples' || c.filters !== filters || typeof c.day !== 'string') throw new AppError('INVALID_CURSOR'); where.push('day<?'); values.push(c.day); }
  const rows = await store.db.prepare(`WITH samples AS (SELECT *,LAG(playtime_minutes) OVER(ORDER BY day) AS previous_minutes,LAG(captured_at) OVER(ORDER BY day) AS previous_sample_at FROM steam_playtime_samples WHERE content_id=?) SELECT * FROM samples WHERE ${where.join(' AND ')} ORDER BY day DESC LIMIT ?`).bind(...values, q.limit + 1).all<{ day: string; title: string; playtime_minutes: number; captured_at: string; previous_minutes: number | null; previous_sample_at: string | null }>();
  const items: { day_utc: string; captured_at: string; cumulative_minutes: number; previous_sample_at: string | null; observed_increment_minutes: number | null; cumulative_counter_decreased: boolean }[] = []; let bytes = 0;
  for (const row of rows.results.slice(0, q.limit)) {
    const item = { day_utc: row.day, captured_at: row.captured_at, cumulative_minutes: row.playtime_minutes, previous_sample_at: row.previous_sample_at, observed_increment_minutes: row.previous_minutes === null || row.playtime_minutes < row.previous_minutes ? null : row.playtime_minutes - row.previous_minutes, cumulative_counter_decreased: row.previous_minutes !== null && row.playtime_minutes < row.previous_minutes };
    const size = new TextEncoder().encode(JSON.stringify(item)).length; if (items.length && bytes + size > 11000) break; items.push(item); bytes += size;
  }
  const more = rows.results.length > items.length;
  const rangeWhere=['1=1'];const rangeValues:(string|number)[]=[q.app_id];if(q.after){rangeWhere.push('captured_at>=?');rangeValues.push(new Date(q.after).toISOString());}if(q.before){rangeWhere.push('captured_at<?');rangeValues.push(new Date(q.before).toISOString());}
  const stats=await store.db.prepare(`WITH samples AS (SELECT *,LAG(playtime_minutes) OVER(ORDER BY day) AS previous_minutes,LAG(captured_at) OVER(ORDER BY day) AS previous_at FROM steam_playtime_samples WHERE content_id=?) SELECT COUNT(*) AS sample_days,MIN(captured_at) AS first_sample_at,MAX(captured_at) AS last_sample_at,MIN(previous_at) AS earliest_interval_baseline_at,SUM(CASE WHEN previous_minutes IS NOT NULL AND playtime_minutes>=previous_minutes THEN 1 ELSE 0 END) AS comparable_intervals,SUM(CASE WHEN previous_minutes IS NOT NULL AND playtime_minutes<previous_minutes THEN 1 ELSE 0 END) AS counter_decreases,SUM(CASE WHEN previous_minutes IS NOT NULL AND playtime_minutes>=previous_minutes THEN playtime_minutes-previous_minutes ELSE 0 END) AS observed_increase_minutes FROM samples WHERE ${rangeWhere.join(' AND ')}`).bind(...rangeValues).first<{sample_days:number;first_sample_at:string|null;last_sample_at:string|null;earliest_interval_baseline_at:string|null;comparable_intervals:number|null;counter_decreases:number|null;observed_increase_minutes:number|null}>();
  const trend={...stats,status:(stats?.comparable_intervals??0)>0?'observed_intervals_available':'insufficient_samples',observed_increase_minutes:(stats?.comparable_intervals??0)>0?stats?.observed_increase_minutes:null};
  return { schema_version: '1.0', app_id: q.app_id, title: rows.results[0]?.title.slice(0,240) ?? null, items, trend, has_more: more, next_cursor: more && items.length ? signCursor({ kind: 'steam_samples', filters, day: items.at(-1)!.day_utc }, store.secret) : null, warnings: ['每日仅保留当日最后一次完整同步的可见累计分钟数。差值覆盖两个采样时点之间，不是逐场游戏日志；计数回退时不推断负游玩时间。', '汇总覆盖当前日期范围内样本对应的可比较区间，起点可能早于查询开始；数据间隔不等于连续每日覆盖。','没有样本不代表没有玩过，首次采样前的历史无法回溯。'] };
}
