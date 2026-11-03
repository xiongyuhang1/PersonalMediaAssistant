import { z } from 'zod';
import { type MediaRecord, type Platform, platforms, recordSchema } from './contracts.ts';
import type { CloudStore } from './store.ts';
import type { BilibiliAdapter } from './adapters.ts';
import { AppError, hash } from './security.ts';

const text = z.string().trim().min(1).max(100).regex(/[\p{L}\p{N}]/u, 'Search phrase needs letters or digits');
const workRef = z.string().regex(/^(steam|bilibili|netease|dandanplay):[A-Za-z0-9_-]{1,100}$/);
export const relatedSchema = z.object({ query: text, source_platform: z.enum(platforms).optional(), source_id: z.string().min(1).max(100).optional(), target_types: z.array(z.enum(['game', 'video', 'music', 'anime'])).min(1).max(4).default(['game', 'video', 'music', 'anime']), limit: z.number().int().min(1).max(20).default(10) }).strict().refine(v => Boolean(v.source_id) === Boolean(v.source_platform), 'Source reference requires platform and ID');
export const workRelatedSchema = z.object({ work_ref: workRef, limit: z.number().int().min(1).max(20).default(10) }).strict();
export const recommendSchema = z.object({ limit: z.number().int().min(5).max(10).default(8), preference_hints: z.array(z.object({ text, origin: z.enum(['user_statement', 'chat_memory_context']) }).strict()).max(5).default([]), exclude_topics: z.array(text).max(10).default([]), exploration_ratio: z.number().min(0).max(0.5).default(0.25) }).strict();
const targetPlatforms = { game: 'steam', video: 'bilibili', music: 'netease', anime: 'dandanplay' } as const;
const summary = (r: MediaRecord) => ({ work_ref: `${r.platform}:${r.content_id}`, platform: r.platform, content_id: r.content_id, title: r.title.slice(0, 180), dataset: r.dataset, artists: r.artists?.slice(0, 3).map(v => v.slice(0, 80)), album: r.album?.slice(0, 180), album_id:r.album_id, artist_ids:r.artist_ids, evidence_urls:r.evidence_urls, collected_at: r.collected_at });
const normalized = (v: string) => v.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
const terminal = (code: string) => ['RISK_CONTROLLED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'AUTH_EXPIRED', 'PERMISSION_DENIED'].includes(code);
const safeCode = (error: unknown) => error instanceof AppError ? error.code : 'UPSTREAM_CHANGED';
function parsed(rows: Array<{ payload: string }>) {
  const items: MediaRecord[] = []; let invalid = 0;
  for (const row of rows) { try { items.push(recordSchema.parse(JSON.parse(row.payload))); } catch { invalid++; } }
  return { items, invalid };
}

export async function searchRelated(store: CloudStore, args: unknown) {
  const input = relatedSchema.parse(args); const targets = input.target_types.map(v => targetPlatforms[v]);
  const sourceRow=input.source_platform&&input.source_id?await store.db.prepare("SELECT payload FROM media_records WHERE platform=? AND content_id=? AND dataset NOT IN ('episodes','achievements','playlists','listening_stats','followings','subtitles') ORDER BY collected_at DESC LIMIT 1").bind(input.source_platform,input.source_id).first<{payload:string}>():null;
  const source=sourceRow?parsed([sourceRow]).items[0]??null:null;
  const sources = await Promise.all(targets.map(async platform => {
    try {
      const rows = await store.db.prepare("SELECT payload FROM media_records WHERE platform=? AND dataset NOT IN ('episodes','achievements','playlists','listening_stats','followings','subtitles') AND (instr(lower(title),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.album'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.artists'),'')),lower(?))>0 OR (platform='steam' AND json_extract(payload,'$.official_soundtrack_of')=?) OR (platform='netease' AND json_extract(payload,'$.album_id')=?)) ORDER BY CASE WHEN platform=? AND content_id=? THEN 0 ELSE 1 END,collected_at DESC,id LIMIT 40").bind(platform, input.query, input.query, input.query, input.source_platform==='steam'?input.source_id??'':'',source?.platform==='netease'?source.album_id??'':'', input.source_platform ?? '', input.source_id ?? '').all<{ payload: string }>();
      const data = parsed(rows.results); const items = new Map<string, ReturnType<typeof summary> & { relation: string; confirmed: boolean; confidence: string; evidence: string[] }>();
      for (const row of data.items) {
        const exactId = row.platform === input.source_platform && row.content_id === input.source_id;
        const q = normalized(input.query);
        const evidence = [normalized(row.title).includes(q) ? 'title_contains_query' : '', row.album && normalized(row.album).includes(q) ? 'album_contains_query' : '', row.artists?.some(v => normalized(v).includes(q)) ? 'artist_contains_query' : ''].filter(Boolean);
        const official=source?.platform==='steam'&&row.platform==='steam'&&row.official_soundtrack_of===source.content_id;const sameAlbum=source?.platform==='netease'&&row.platform==='netease'&&Boolean(source.album_id)&&source.album_id===row.album_id;
        const prior=items.get(`${row.platform}:${row.content_id}`);if(prior&&(prior.confirmed||!(exactId||official||sameAlbum)))continue;
        items.set(`${row.platform}:${row.content_id}`, { ...summary(row), relation: exactId ? 'same_platform_item' : official?'official_game_soundtrack':sameAlbum?'same_album':'related_content_candidate', confirmed: exactId||official||sameAlbum, confidence: exactId ? 'exact_source_id' : official||sameAlbum?'verified_platform_metadata':'unverified', evidence: exactId ? ['same_namespaced_platform_id'] : official?['steam_type_music_and_fullgame_appid',...(row.evidence_urls??[])]:sameAlbum?['same_netease_album_id:'+row.album_id]:evidence });
      }
      return { platform, status: data.invalid ? 'partial' : 'ok', items: [...items.values()], invalid_records: data.invalid, limit_reached: rows.results.length === 40 };
    } catch { return { platform, status: 'unavailable', items: [], invalid_records: 0, limit_reached: false }; }
  }));
  const candidates = sources.flatMap(v => v.items).sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.evidence.length - a.evidence.length || a.work_ref.localeCompare(b.work_ref));
  const result = { schema_version: '1.0', status: sources.some(v => v.status !== 'ok') ? 'partial' : 'ok', query: input.query, items: candidates.slice(0, input.limit), has_more: candidates.length > input.limit || sources.some(v => v.limit_reached), response_truncated: false, sources: sources.map(({ items, ...source }) => ({ ...source, matched_items: items.length })), warnings: ['查询范围是已同步缓存；没有匹配不代表平台上不存在。', '同平台相同内容ID确认同一条目；相同网易云专辑ID确认同专辑关系；Steam官方type=music+fullgame.appid确认原声关系。其他跨平台标题/艺人匹配仍是候选，不自动确认网易云OST或OP/ED关系。'] };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 14000 && result.items.length) { result.items.pop(); result.has_more = true; result.response_truncated = true; }
  return result;
}

export async function workRelated(store: CloudStore, args: unknown) {
  const input = workRelatedSchema.parse(args); const colon = input.work_ref.indexOf(':');
  const platform = input.work_ref.slice(0, colon) as Platform, id = input.work_ref.slice(colon + 1);
  const rows = await store.db.prepare("SELECT payload FROM media_records WHERE platform=? AND content_id=? AND dataset NOT IN ('episodes','achievements','playlists','listening_stats','followings','subtitles') ORDER BY collected_at DESC LIMIT 5").bind(platform, id).all<{ payload: string }>();
  const seed = parsed(rows.results).items[0]; if (!seed) throw new AppError('WORK_NOT_IN_SYNCED_CACHE', 404);
  return { ...await searchRelated(store, { query: seed.title.slice(0, 100), source_platform: platform, source_id: id, limit: input.limit }), seed: summary(seed) };
}

export type Seed = { source: Platform | 'explicit_context' | 'exploration_policy'; query: string; title: string; evidence_kind: string; work_ref?: string; collected_at?: string; exploration: boolean };
export async function recommendationSeeds(store: CloudStore, configured: Record<Platform, boolean>, input: z.infer<typeof recommendSchema>) {
  const selections: Record<Platform, string> = {
    steam: "SELECT payload FROM media_records WHERE platform='steam' AND dataset IN ('recent_games','owned_games') AND COALESCE(json_extract(payload,'$.recent_playtime_minutes'),json_extract(payload,'$.playtime_minutes'),0)>0 ORDER BY CASE dataset WHEN 'recent_games' THEN 0 ELSE 1 END,COALESCE(json_extract(payload,'$.recent_playtime_minutes'),json_extract(payload,'$.playtime_minutes'),0) DESC,id LIMIT 3",
    netease: "SELECT payload FROM media_records WHERE platform='netease' AND dataset IN ('user_record_week','user_record_all','favorites') ORDER BY CASE dataset WHEN 'user_record_week' THEN 0 WHEN 'user_record_all' THEN 1 ELSE 2 END,COALESCE(json_extract(payload,'$.rank'),999999),id LIMIT 3",
    bilibili: "SELECT r.payload FROM media_records r WHERE r.platform='bilibili' AND r.dataset IN ('likes','coins','history','favorites') AND COALESCE((SELECT f.feedback FROM media_feedback f WHERE f.platform='bilibili' AND f.content_id=r.content_id ORDER BY f.created_at DESC,f.request_id DESC LIMIT 1),'') NOT IN ('dislike','inaccurate') ORDER BY CASE WHEN (SELECT f.feedback FROM media_feedback f WHERE f.platform='bilibili' AND f.content_id=r.content_id ORDER BY f.created_at DESC,f.request_id DESC LIMIT 1)='like' THEN 0 ELSE 1 END,CASE r.dataset WHEN 'likes' THEN 0 WHEN 'coins' THEN 1 WHEN 'favorites' THEN 2 ELSE 3 END,r.source_time DESC,r.id LIMIT 3",
    dandanplay: "SELECT payload FROM media_records WHERE platform='dandanplay' AND dataset='watchlist' AND json_extract(payload,'$.user_rating') IN (8,10) AND COALESCE(json_extract(payload,'$.completion_state'),'unknown')<>'abandoned' ORDER BY json_extract(payload,'$.user_rating') DESC,id LIMIT 3",
  };
  const sources = await Promise.all(platforms.map(async platform => {
    try {
      const [records, states] = await store.db.batch([store.db.prepare(selections[platform]), store.db.prepare('SELECT dataset,state,last_success,error_code FROM platform_sync_state WHERE platform=? ORDER BY dataset').bind(platform)]);
      const data = parsed(records.results as { payload: string }[]);
      const datasets = states.results as { dataset: string; state: string; last_success: string | null; error_code: string | null }[];
      return { platform, configured: configured[platform], status: data.invalid ? 'partial' : datasets.length && datasets.every(v => v.state === 'synced') ? 'ok' : 'partial', datasets, records: data.items };
    } catch { return { platform, configured: configured[platform], status: 'unavailable', datasets: [], records: [] }; }
  }));
  const seeds: Seed[] = input.preference_hints.map(v => ({ source: 'explicit_context', query: v.text, title: v.text, evidence_kind: v.origin, exploration: false }));
  for (const source of sources) {
    for (const item of source.records) {
      if (input.exclude_topics.some(v => normalized(item.title).includes(normalized(v)))) continue;
      const suffix = source.platform === 'steam' ? ' 二创' : source.platform === 'dandanplay' ? ' OP ED' : '';
      const title = item.title.slice(0, 70); const artist = item.artists?.[0]?.slice(0, 20);
      seeds.push({ source: source.platform, query: (title + (source.platform === 'netease' && artist ? ' ' + artist : '') + suffix).slice(0, 100), title, work_ref: `${source.platform}:${item.content_id}`, collected_at: item.collected_at, evidence_kind: item.user_rating === 10 || item.user_rating === 8 ? 'explicit_personal_rating' : item.record_kind, exploration: false });
      break;
    }
  }
  // Context is explicit; behavioral records provide evidence, not a claim of liking.
  const balanced: Seed[] = []; const queryKeys = new Set<string>();
  for (const seed of seeds) { const key = normalized(seed.query); if (!queryKeys.has(key)) { queryKeys.add(key); balanced.push(seed); } }
  // Five explicit phrases plus one record from each platform fit a bounded
  // plan. Do not drop the fourth platform just to reserve an exploration query.
  const queries = balanced.slice(0, 9);
  if (input.exploration_ratio > 0) queries.push({ source: 'exploration_policy', query: '游戏 音乐 创作 解析', title: '游戏、音乐创作与设计探索', evidence_kind: 'exploration_policy', exploration: true });
  return { queries, sources: sources.map(({ records, ...source }) => ({ ...source, available_seed_records: records.length, seed_records: records.filter(item => queries.some(seed => seed.work_ref === `${item.platform}:${item.content_id}`)).slice(0, 1).map(summary) })) };
}

type Video = MediaRecord & { quality?: { views?: number; likes?: number; coins?: number; favorites?: number }; description?: string; tags?: string[] };
export interface DiscoveryClient { search(keyword: string): ReturnType<BilibiliAdapter['search']>; details(bvid: string): Promise<Video>; }
export async function recommendVideos(store: CloudStore, configured: Record<Platform, boolean>, client: DiscoveryClient, args: unknown, now = Date.now()) {
  const input = recommendSchema.parse(args); const plan = await recommendationSeeds(store, configured, input);
  const state = await store.db.prepare("SELECT dataset,state,last_success,error_code FROM platform_sync_state WHERE platform='bilibili' AND dataset IN ('history','favorites') ORDER BY dataset").all<{ dataset: string; state: string; last_success: string | null; error_code: string | null }>();
  const exclusionCoverage = { cache_ready: state.results.length === 2 && state.results.every(v => v.state === 'synced' && v.last_success), guarantee_unseen: false, scope: 'observed_cache_window_and_explicit_feedback', datasets: state.results };
  const queries: Array<{ query: string; source: string; exploration: boolean; status: string; code?: string }> = [];
  const pool = new Map<string, { item: MediaRecord; seeds: Seed[] }>(); const errors: string[] = []; const started = Date.now();
  const cooldown = await store.db.prepare("SELECT value FROM pma_meta WHERE key='bilibili_discovery_cooldown'").first<{ value: string }>();
  if (cooldown) { try { const value = JSON.parse(cooldown.value); if (typeof value.until === 'number' && value.until > now && ['RISK_CONTROLLED', 'RATE_LIMITED'].includes(value.code)) errors.push(value.code); } catch { /* Ignore invalid stale metadata. */ } }
  if (!configured.bilibili) errors.push('AUTH_REQUIRED');
  let stopped = errors.length > 0;
  const fail = async (code: string) => {
    errors.push(code); if (terminal(code)) stopped = true;
    if (['RISK_CONTROLLED', 'RATE_LIMITED'].includes(code)) await store.db.prepare("INSERT INTO pma_meta(key,value) VALUES('bilibili_discovery_cooldown',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ code, until: now + 600000 })).run();
  };
  for (const seed of plan.queries) {
    if (stopped || Date.now() - started > 18000) { if (!stopped && !errors.includes('DISCOVERY_BUDGET_REACHED')) errors.push('DISCOVERY_BUDGET_REACHED'); queries.push({ query: seed.query, source: seed.source, exploration: seed.exploration, status: 'skipped' }); continue; }
    try {
      const result = await client.search(seed.query);
      for (const item of result.items.slice(0, 20)) {
        if (!/^BV[A-Za-z0-9]{10}$/.test(item.content_id)) continue;
        const previous = pool.get(item.content_id); if (previous) previous.seeds.push(seed); else pool.set(item.content_id, { item, seeds: [seed] });
      }
      queries.push({ query: seed.query, source: seed.source, exploration: seed.exploration, status: 'ok' });
    } catch (error) { const code = safeCode(error); await fail(code); queries.push({ query: seed.query, source: seed.source, exploration: seed.exploration, status: 'unavailable', code }); }
  }
  const excluded = { seen_or_saved: 0, known_interaction: 0, negative_feedback: 0, topic: 0, unavailable_details: 0, duplicate_creator: 0 };
  const candidates: Array<{ item: Video; seeds: Seed[]; score: number; score_components: { relevance: number; quality_signal: number; freshness: number }; exploration: boolean }> = [];
  // Candidate IDs are bounded by ten search pages; exclusions use all matching
  // cache/feedback rows, not only the first page of the user's history.
  const candidateIds = [...pool.keys()]; const blocked = new Map<string, string>();
  for (let offset = 0; offset < candidateIds.length; offset += 30) {
    const ids = candidateIds.slice(offset, offset + 30); const places = ids.map(() => '?').join(',');
    const [cache, feedback] = await store.db.batch([
      store.db.prepare(`SELECT DISTINCT content_id,dataset FROM media_records WHERE platform='bilibili' AND dataset IN ('history','favorites','likes','coins') AND content_id IN (${places})`).bind(...ids),
      store.db.prepare(`SELECT content_id,feedback FROM (SELECT content_id,feedback,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY created_at DESC,request_id DESC) AS position FROM media_feedback WHERE platform='bilibili' AND content_id IN (${places})) WHERE position=1`).bind(...ids),
    ]);
    for (const row of cache.results as { content_id: string; dataset: string }[]) { const reason=['likes','coins'].includes(row.dataset)?'known_interaction':'seen_or_saved';if(reason==='seen_or_saved'||!blocked.has(row.content_id))blocked.set(row.content_id,reason); }
    for (const row of feedback.results as { content_id: string; feedback: string }[]) {
      if (['dislike', 'inaccurate'].includes(row.feedback)) blocked.set(row.content_id, 'negative_feedback');
      else if (['seen', 'saved'].includes(row.feedback) && !blocked.has(row.content_id)) blocked.set(row.content_id, 'seen_or_saved');
    }
  }
  // Interleave queries before checking details so the first search cannot use
  // the entire budget and starve music/anime/exploration candidates.
  const groups = plan.queries.map(seed => [...pool.values()].filter(entry => entry.seeds.includes(seed)));
  const ordered: Array<{ item: MediaRecord; seeds: Seed[] }> = []; const orderedIds = new Set<string>();
  for (let index = 0; index < 20; index++) for (const group of groups) { const entry = group[index]; if (entry && !orderedIds.has(entry.item.content_id)) { orderedIds.add(entry.item.content_id); ordered.push(entry); } }
  let detailsFetched = 0;
  for (const entry of ordered) {
    const reason = blocked.get(entry.item.content_id); if (reason) { excluded[reason as 'seen_or_saved' | 'known_interaction' | 'negative_feedback']++; continue; }
    if (input.exclude_topics.some(v => normalized(entry.item.title).includes(normalized(v)))) { excluded.topic++; continue; }
    if (stopped || detailsFetched >= 14 || Date.now() - started > 18000) break;
    try {
      detailsFetched++; const item = await client.details(entry.item.content_id);
      if (item.content_id !== entry.item.content_id || !/^BV[A-Za-z0-9]{10}$/.test(item.content_id)) throw new AppError('UPSTREAM_CHANGED', 502);
      if (input.exclude_topics.some(v => normalized([item.title, ...(item.tags ?? [])].join(' ')).includes(normalized(v)))) { excluded.topic++; continue; }
      const q = item.quality; const views = q?.views ?? 0;
      const quality = Math.min(12, Math.log10(views + 1) * 2) + Math.min(8, ((q?.likes ?? 0) + (q?.coins ?? 0) + (q?.favorites ?? 0)) / Math.max(views, 100) * 20);
      const age = item.published_at ? Math.max(0, (now - Date.parse(item.published_at)) / 86400000) : undefined;
      const freshness = age === undefined ? 0 : 10 / (1 + age / 90);
      const relevance = Math.min(40, 24 + (entry.seeds.length - 1) * 4 + (entry.seeds.some(v => v.evidence_kind === 'user_statement' || v.evidence_kind === 'chat_memory_context') ? 8 : 0));
      candidates.push({ item, seeds: entry.seeds, score: relevance + quality + freshness, score_components: { relevance, quality_signal: Number(quality.toFixed(2)), freshness: Number(freshness.toFixed(2)) }, exploration: entry.seeds.every(v => v.exploration) });
    } catch (error) { excluded.unavailable_details++; await fail(safeCode(error)); }
  }
  candidates.sort((a, b) => b.score - a.score || a.item.content_id.localeCompare(b.item.content_id));
  const chosen: typeof candidates = [], creators = new Map<string, number>(); const targetExploration = Math.ceil(input.limit * input.exploration_ratio);
  const add = (candidate: typeof candidates[number]) => {
    if (chosen.includes(candidate)) return;
    const creator = candidate.item.uploader_id; if (creator && (creators.get(creator) ?? 0) >= 2) { excluded.duplicate_creator++; return; }
    chosen.push(candidate); if (creator) creators.set(creator, (creators.get(creator) ?? 0) + 1);
  };
  for (const candidate of candidates.filter(v => v.exploration)) { if (chosen.length >= targetExploration) break; add(candidate); }
  for (const candidate of candidates.filter(v => !v.exploration)) { if (chosen.length >= input.limit) break; add(candidate); }
  for (const candidate of candidates) { if (chosen.length >= input.limit) break; add(candidate); }
  chosen.sort((a, b) => b.score - a.score || a.item.content_id.localeCompare(b.item.content_id));
  const items = chosen.map(({ item, seeds, score_components, exploration }, index) => ({ rank: index + 1, platform: 'bilibili', content_id: item.content_id, title: item.title.slice(0, 120), url: `https://www.bilibili.com/video/${item.content_id}`, uploader: item.uploader_name?.slice(0, 60), published_at: item.published_at, tags: item.tags?.slice(0, 4).map(v => v.slice(0, 40)), quality: item.quality, score_components, exploration, reasons: seeds.slice(0, 2).map(seed => ({ source: seed.source, work_ref: seed.work_ref, evidence_kind: seed.evidence_kind, text: seed.exploration ? '来自较宽的创作与设计探索检索；不保证此前未接触该主题。' : `由“${seed.title.slice(0, 50)}”的${seed.evidence_kind === 'explicit_personal_rating' ? '明确个人评分' : seed.source === 'explicit_context' ? '显式偏好上下文' : '平台记录'}生成检索；匹配是候选依据，不能证明作品关联。` })), metadata_checked_at: item.collected_at }));
  const partial = errors.length > 0 || !exclusionCoverage.cache_ready || items.length < input.limit || plan.sources.some(v => v.status !== 'ok');
  const result = { schema_version: '1.0', recommendation_id: 'rec_' + hash(JSON.stringify([now, items.map(v => v.content_id)])).slice(0, 20), generated_at: new Date(now).toISOString(), status: !items.length && errors.length ? 'unavailable' : partial ? 'partial' : 'ok', requested_count: input.limit, response_truncated: false, items, sources: plan.sources, queries, excluded, exclusion_coverage: exclusionCoverage, exploration: { requested: targetExploration, returned: chosen.filter(v => v.exploration).length, meaning: 'broader_search_direction_not_proven_unfamiliar_work' }, errors: [...new Set(errors)], warnings: ['排序分数是可解释的启发式，不是喜欢概率；播放量等质量信号不代表内容必然好看。', '只排除已同步缓存及用户明确反馈中的已看/收藏/不喜欢；历史覆盖缺失时不能保证从未看过。', '时长、排行、收藏和明确评分分别表达；不自动读取ChatGPT Memory、日记或更改平台账号。', '默认最多5次检索（有额外偏好时上限10次）、14条详情，单次18秒预算；风控或限流后暂停10分钟，不编造候选补足数量。'] };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 14000) {
    result.response_truncated = true; result.status = 'partial';
    const source = result.sources.find(v => v.seed_records.length); if (source) { source.seed_records.pop(); continue; }
    const tagged = result.items.find(v => v.tags?.length); if (tagged) { tagged.tags!.pop(); continue; }
    const verbose = result.items.find(v => v.reasons.length > 1); if (verbose) { verbose.reasons.pop(); continue; }
    if (!result.items.length) break; result.items.pop();
  }
  result.exploration.returned = result.items.filter(v => v.exploration).length;
  return result;
}
