import { z } from 'zod';
import type { CloudStore } from './store.ts';
import { type Platform, recordSchema } from './contracts.ts';
import { dandanplayRatingScale } from './dandanplay.ts';

export const insightsSchema = z.object({ focus: z.enum(['overview', 'games', 'music', 'anime']).default('overview'), include_game_ost: z.boolean().default(false), include_anime_music: z.boolean().default(false) }).strict();
export function insightPlatforms(args: z.infer<typeof insightsSchema>): Platform[] {
  const sources: Platform[] = args.focus === 'music' ? ['netease', 'bilibili'] : args.focus === 'games' ? ['steam', 'bilibili', 'netease'] : args.focus === 'anime' ? ['dandanplay', 'bilibili', 'netease'] : ['steam', 'bilibili', 'netease', 'dandanplay'];
  if (args.focus === 'music' && args.include_game_ost) sources.push('steam');
  if (args.focus === 'music' && args.include_anime_music) sources.push('dandanplay');
  return sources;
}
export async function analyzeInterests(store: CloudStore, configured: Record<Platform, boolean>, args: unknown) {
  const input = insightsSchema.parse(args); const sources = insightPlatforms(input);
  const results = await Promise.all(sources.map(async platform => {
    try {
    const [statistics, state, evidence] = await store.db.batch([
      store.db.prepare("SELECT dataset,json_extract(payload,'$.record_kind') AS record_kind,COUNT(*) AS records,SUM(CASE WHEN source_time IS NULL THEN 1 ELSE 0 END) AS undated_records,MIN(source_time) AS earliest_observed_time,MAX(source_time) AS latest_observed_time,MAX(collected_at) AS last_collected_at FROM media_records WHERE platform=? GROUP BY dataset,record_kind ORDER BY dataset,record_kind LIMIT 30").bind(platform),
      store.db.prepare('SELECT dataset,state,last_success,error_code FROM platform_sync_state WHERE platform=? ORDER BY dataset').bind(platform),
      platform === 'dandanplay' ? store.db.prepare("SELECT payload FROM media_records WHERE platform='dandanplay' AND dataset='watchlist' AND json_extract(payload,'$.user_rating')>0 ORDER BY json_extract(payload,'$.user_rating') DESC,id LIMIT 5")
        : platform === 'steam' ? store.db.prepare("SELECT payload FROM media_records WHERE platform='steam' AND dataset='owned_games' AND json_extract(payload,'$.playtime_minutes')>0 ORDER BY json_extract(payload,'$.playtime_minutes') DESC,id LIMIT 5")
        : platform === 'bilibili' ? store.db.prepare("SELECT payload FROM media_records WHERE platform='bilibili' AND dataset IN ('likes','coins','favorites','history') ORDER BY CASE dataset WHEN 'likes' THEN 0 WHEN 'coins' THEN 1 WHEN 'favorites' THEN 2 ELSE 3 END,source_time DESC,id LIMIT 5")
        : store.db.prepare("SELECT payload FROM media_records WHERE platform='netease' AND dataset IN ('user_record_week','user_record_all','favorites') ORDER BY CASE dataset WHEN 'user_record_week' THEN 0 WHEN 'user_record_all' THEN 1 ELSE 2 END,COALESCE(json_extract(payload,'$.rank'),999999),id LIMIT 5"),
    ]);
    const facts = evidence.results.map((row: any) => {
      const item = recordSchema.parse(JSON.parse(row.payload));
      return { id: item.content_id, title: item.title.slice(0, 120), title_truncated: item.title.length > 120, dataset: item.dataset, interaction: item.interaction, coins_given: item.coins_given, source_time: item.source_time, source_time_semantics: item.source_time_semantics, evidence_kind: item.user_rating ? 'explicit_personal_rating' : item.record_kind, user_rating: item.user_rating, user_comment: item.user_comment?.slice(0, 200), completion_state: item.completion_state, playtime_minutes: item.playtime_minutes, rank: item.rank, play_count: item.play_count, rank_score: item.rank_score, artists: item.artists?.slice(0, 3).map(artist => artist.slice(0, 80)), collected_at: item.collected_at };
    });
    const datasets = state.results as Array<{ dataset: string; state: string; last_success: string | null; error_code: string | null }>;
    const ready = datasets.length > 0 && datasets.every(row => row.state === 'synced');
    return { platform, status: ready ? 'ok' : datasets.length ? 'partial' : 'unavailable', configured: configured[platform], source_status: datasets.length ? 'cached_records' : configured[platform] ? 'sync_required' : 'auth_required', datasets, statistics: statistics.results, evidence: facts, evidence_truncated: false, ...(platform === 'dandanplay' ? { rating_scale: dandanplayRatingScale, watchlist_summary: await store.watchlistSummary() } : {}) };
    } catch { return { platform, status: 'unavailable', configured: configured[platform], source_status: 'cache_query_failed', datasets: [], statistics: [], evidence: [], evidence_truncated: false }; }
  }));
  const result = { schema_version: '1.0', status: results.every(row => row.status === 'ok') ? 'ok' : results.every(row => row.status === 'unavailable') ? 'unavailable' : 'partial', focus: input.focus, queried_platforms: sources, sources: results, interpretation: '这是缓存中的事实摘要，供ChatGPT结合用户明确偏好理解；不自动推断作品关联或训练兴趣画像。', warnings: ['时长、收藏、排行和明确个人评分具有不同含义；未评分不代表不喜欢。', '来源失败、未授权或未同步时保留缺口，不视为没有行为。', '没有日期的状态不构造历史事件，最后观看观察不代表每次观看；本工具不声称完成时间趋势分析。', '证据每个平台最多5条，受响应预算约束；未列出不代表没有其他记录。'] };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 14000) {
    const largest = results.filter(row => row.evidence.length).sort((a, b) => JSON.stringify(b.evidence).length - JSON.stringify(a.evidence).length)[0];
    if (!largest) break;
    largest.evidence.pop(); largest.evidence_truncated = true;
  }
  return result;
}
