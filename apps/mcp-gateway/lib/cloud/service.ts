import { z } from 'zod';
import { CloudStore } from './store.ts';
import { BilibiliAdapter, NeteaseAdapter, SteamAdapter } from './adapters.ts';
import { platforms, querySchema, syncSchema, ingestSchema, feedbackSchema, type Platform, type Dataset } from './contracts.ts';
import { AppError, hash } from './security.ts';
import { weapi, eapi } from './netease-transport.ts';
import { dandanplayRatingScale } from './dandanplay.ts';
import { exportDescriptor } from './export.ts';
import { analyzeInterests } from './insights.ts';
import { searchRelated, workRelated, recommendVideos } from './discovery.ts';
import { crossPlatformTimeline, steamPlaytimeHistory } from './timeline.ts';
import { deletionPreview, deletePersonalData, resumeSync } from './data-management.ts';
import { steamAchievements } from './achievements.ts';
import { neteaseLyrics } from './netease-extra.ts';
import { bilibiliSubtitles } from './subtitles.ts';
import { refreshWorkMetadata } from './work-metadata.ts';
export type CloudEnv = { DB?: D1Database; PMA_CURSOR_KEY?: string; PMA_INGEST_TOKEN?: string; PMA_BILI_INGEST_TOKEN?: string; PMA_REFRESH_TOKEN?: string; PMA_INGEST_DEVICE_ID?: string; STEAM_API_KEY?: string; STEAM_ID?: string; BILIBILI_COOKIE?: string; NETEASE_COOKIE?: string; NETEASE_UID?: string };
export class MediaService {
  store: CloudStore; adapters: Map<Platform, SteamAdapter | BilibiliAdapter | NeteaseAdapter>;
  constructor(public env: CloudEnv, private fetcher: typeof fetch = fetch) {
    if (!env.DB || !env.PMA_CURSOR_KEY || env.PMA_CURSOR_KEY.length < 32) throw new AppError('CLOUD_CONFIGURATION_REQUIRED', 503);
    this.store = new CloudStore(env.DB, env.PMA_CURSOR_KEY);
    const settings = { steamKey: env.STEAM_API_KEY, steamId: env.STEAM_ID, biliCookie: env.BILIBILI_COOKIE, neteaseCookie: env.NETEASE_COOKIE, neteaseUid: env.NETEASE_UID };
    this.adapters = new Map<Platform, SteamAdapter | BilibiliAdapter | NeteaseAdapter>([['steam', new SteamAdapter(settings, fetcher)], ['bilibili', new BilibiliAdapter(settings, fetcher)], ['netease', new NeteaseAdapter(settings, fetcher)]]);
  }
  configured() { return Object.fromEntries(platforms.map(p => [p, p === 'dandanplay' ? Boolean(this.env.PMA_INGEST_TOKEN) : this.adapters.get(p)?.configured ?? false])) as Record<Platform, boolean>; }
  async cached(platform: Platform, dataset: Dataset, args: Record<string, unknown>) {
    const state = await this.store.state(platform, dataset);
    if (!state) throw new AppError(platform === 'dandanplay' ? 'LOCAL_SYNC_REQUIRED' : this.configured()[platform] ? 'SYNC_REQUIRED' : 'AUTH_REQUIRED', 409);
    return { ...await this.store.query(querySchema.parse({ ...args, platform, dataset })), ...(platform === 'dandanplay' && dataset === 'watchlist' ? { watchlist_summary: await this.store.watchlistSummary(), rating_scale: dandanplayRatingScale } : {}), status: state.state === 'synced' ? 'ok' : 'partial', source_status: { state: state.state, last_successful_sync_at: state.last_success, error_code: state.error_code } };
  }
  async sync(args: unknown) {
    const input = syncSchema.parse(args); const adapter = this.adapters.get(input.platform);
    if(input.platform==='bilibili'&&this.env.PMA_BILI_INGEST_TOKEN)throw new AppError('LOCAL_COLLECTOR_REQUIRED',409);
    await this.store.assertSyncAllowed(input.platform);
    const syncControl=await this.store.control(input.platform);
    if(input.platform==='steam'&&['achievements','related_works'].includes(input.dataset)){if(!input.app_id)throw new AppError('APP_ID_REQUIRED');const result=input.dataset==='achievements'?await steamAchievements(this.store,adapter as SteamAdapter,{app_id:input.app_id,refresh:true,limit:1},this.fetcher):await refreshWorkMetadata(this.store,{app_id:input.app_id,candidate_app_ids:input.candidate_app_ids},this.fetcher);return {schema_version:'1.0',status:result.status,app_id:input.app_id,has_more:false,records_committed:input.dataset==='achievements'?1:(result as any).items.length,...(input.dataset==='achievements'?{summary:(result as any).summary}:{}),warnings:['按App同步扩展数据；不批量扫描游戏库，不将成就当作剧情通关。']};}
    if(input.app_id||input.candidate_app_ids)throw new AppError('UNSUPPORTED_APP_SCOPE');
    if (!adapter) throw new AppError('LOCAL_COLLECTOR_REQUIRED', 409);
    if (!adapter.datasets.includes(input.dataset)) throw new AppError('UNSUPPORTED_DATASET');
    if (!adapter.configured) throw new AppError('AUTH_REQUIRED', 409);
    const state = await this.store.state(input.platform, input.dataset);
    const stored = !input.restart_cursor && state?.cursor ? JSON.parse(state.cursor) : undefined;
    // Large owned-game snapshots are sliced across calls to fit Worker/D1 budgets.
    const upstream = stored?.slice ? stored.upstream : stored;
    const offset = stored?.slice ? stored.offset as number : 0;
    const generation = stored && state?.generation ? state.generation : crypto.randomUUID();
    try {
      const page = await adapter.page(input.dataset, upstream);
      const digest = hash(JSON.stringify(page.items.map(item => item.id)));
      if (stored?.slice && stored.digest !== digest) throw new AppError('SNAPSHOT_CHANGED_RESTART_REQUIRED', 409);
      const items = page.items.slice(offset, offset + 180);
      const next = offset + items.length < page.items.length ? { slice: true, offset: offset + items.length, upstream: upstream ?? null, digest } : page.next_cursor;
      await this.store.page(input.platform, input.dataset, items, next, generation, page.snapshot, page.coverage_note ?? '按需读取的平台记录。',{epoch:syncControl.sync_epoch,statements:[]});
      return { schema_version: '1.0', status: next !== undefined && next !== null ? 'partial' : 'ok', records_committed: items.length, has_more: next !== undefined && next !== null, last_successful_sync_at: (await this.store.state(input.platform, input.dataset))?.last_success ?? null, warnings: ['单次调用只提交有界的一页，重复调用继续游标；不每次读取全部历史。'] };
    } catch (error) { const code = error instanceof AppError ? error.code : 'UPSTREAM_CHANGED'; if((await this.store.control(input.platform)).sync_epoch===syncControl.sync_epoch)await this.store.fail(input.platform, input.dataset, code); throw new AppError(code, 502, error instanceof AppError ? error.upstream : undefined); }
  }
  async call(name: string, args: Record<string, unknown>) {
    if(name==='steam_get_achievements')return steamAchievements(this.store,this.adapters.get('steam') as SteamAdapter,args,this.fetcher);
    if(name==='refresh_work_metadata')return refreshWorkMetadata(this.store,args,this.fetcher);
    if(name==='netease_get_lyrics')return neteaseLyrics(this.adapters.get('netease') as NeteaseAdapter,args);
    if(name==='bilibili_get_subtitles')return bilibiliSubtitles(this.store,args);
    if(name==='netease_get_playlist_tracks'){const {playlist_id,...filters}=z.object({playlist_id:z.string().regex(/^\d{1,20}$/)}).passthrough().parse(args);return this.cached('netease','playlist_tracks',{...filters,parent_id:playlist_id});}

    if (name === 'get_cross_platform_timeline') return crossPlatformTimeline(this.store, args);
    if (name === 'steam_get_playtime_history') return steamPlaytimeHistory(this.store, args);
    if (name === 'prepare_personal_data_deletion') return deletionPreview(this.store, args);
    if (name === 'delete_personal_data') return deletePersonalData(this.store, args);
    if (name === 'resume_platform_sync') return resumeSync(this.store, args);
    if (name === 'search_related_media') return searchRelated(this.store, args);
    if (name === 'get_work_related_content') return workRelated(this.store, args);
    if (name === 'recommend_bilibili_videos') {
      const deadline = Date.now() + 18000; const transport = this.fetcher;
      const bounded = ((input, init) => transport(input, { ...init, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })) as typeof fetch;
      return recommendVideos(this.store, this.configured(), new BilibiliAdapter({ biliCookie: this.env.BILIBILI_COOKIE }, bounded), args);
    }
    if (name === 'export_personal_data') return exportDescriptor(this.store, args);
    if (name === 'analyze_cross_platform_interests') return analyzeInterests(this.store, this.configured(), args);
    const mappings: Record<string, [Platform, Dataset]> = { netease_get_playlists:['netease','playlists'],netease_get_listening_stats:['netease','listening_stats'],bilibili_get_watch_later:['bilibili','watch_later'],bilibili_get_followings:['bilibili','followings'],steam_get_owned_games: ['steam', 'owned_games'], steam_get_recent_games: ['steam', 'recent_games'], bilibili_get_watch_history: ['bilibili', 'history'], bilibili_get_favorites: ['bilibili', 'favorites'], netease_get_recent_plays: ['netease', 'recent_plays'], netease_get_favorites: ['netease', 'favorites'], dandanplay_get_watchlist: ['dandanplay', 'watchlist'], dandanplay_get_watch_history: ['dandanplay', 'episodes'], dandanplay_get_episode_progress: ['dandanplay', 'episodes'] };
    if (name === 'dandanplay_get_episode_progress') { const { anime_id, episode_id, ...filters } = z.object({ anime_id: z.string().min(1).max(160), episode_id: z.string().max(160).optional() }).passthrough().parse(args); return { ...await this.cached('dandanplay', 'episodes', { ...filters, parent_id: anime_id, ...(episode_id ? { content_id: episode_id } : {}) }), work_status: (await this.store.query(querySchema.parse({ platform: 'dandanplay', dataset: 'watchlist', content_id: anime_id, limit: 1 }))).items[0] ?? null }; }
    if (mappings[name]) { const [platform, dataset] = mappings[name]; return this.cached(platform, dataset, args); }
    if(name==='bilibili_get_recent_interactions'){const {action,...filters}=z.object({action:z.enum(['like','coin'])}).passthrough().parse(args);return this.cached('bilibili',action==='like'?'likes':'coins',filters);}
    if (name === 'get_platform_sync_status') { const input = z.object({ platforms: z.array(z.enum(platforms)).max(4).optional() }).strict().parse(args); const data = await this.store.status(this.configured()); return { ...data, platforms: input.platforms ? data.platforms.filter(p => input.platforms!.includes(p.platform)) : data.platforms }; }
    if (name === 'get_data_coverage') { const input = z.object({ platform: z.enum(platforms).optional() }).strict().parse(args); return this.store.coverage(input.platform); }
    if (name === 'sync_platform_data') return this.sync(args);
    if (name === 'netease_get_user_record') { const { period, ...filters } = z.object({ period: z.enum(['all_time', 'this_week']).default('all_time') }).passthrough().parse(args); return this.cached('netease', period === 'all_time' ? 'user_record_all' : 'user_record_week', filters); }
    if (name === 'bilibili_search_videos') { const input = z.object({ keyword: z.string().min(1).max(100), page: z.number().int().min(1).max(20).default(1) }).strict().parse(args); return (this.adapters.get('bilibili') as BilibiliAdapter).search(input.keyword, input.page); }
    if (name === 'steam_get_profile_summary') { z.object({}).strict().parse(args); if (!await this.store.state('steam', 'owned_games')) throw new AppError('SYNC_REQUIRED', 409); return { summary: await this.store.db.prepare("SELECT COUNT(*) AS owned_games,SUM(COALESCE(json_extract(payload,'$.playtime_minutes'),0)) AS cumulative_game_minutes FROM media_records WHERE platform='steam' AND dataset='owned_games'").first(), coverage: await this.store.coverage('steam'), warnings: ['累计时长不是喜欢程度或完整会话历史。'] }; }
    if (name === 'save_recommendation_feedback') {
      const data = feedbackSchema.parse(args); const digest = hash(JSON.stringify(data));
      const existing = await this.store.db.prepare('SELECT digest FROM media_feedback WHERE request_id=?').bind(data.request_id).first<{ digest: string }>();
      if (existing) { if (existing.digest !== digest) throw new AppError('REQUEST_ID_CONFLICT', 409); return { saved: true, duplicate: true }; }
      await this.store.db.prepare('INSERT INTO media_feedback VALUES(?,?,?,?,?,?,?)').bind(data.request_id, digest, data.platform, data.content_id, data.feedback, data.reason ?? null, new Date().toISOString()).run();
      return { saved: true, duplicate: false, source_account_modified: false };
    }
    throw new AppError('TOOL_NOT_IMPLEMENTED', 404);
  }
  async ingest(input: unknown) { const data = ingestSchema.parse(input); if (data.items.length > 30) throw new AppError('BATCH_TOO_LARGE', 413); if (data.device_id !== this.env.PMA_INGEST_DEVICE_ID) throw new AppError('DEVICE_SCOPE_DENIED', 403); return this.store.ingest(data); }
  async heartbeat(input: unknown) {
    const data = z.object({ schema_version: z.literal('1.0'), device_id: z.string(), heartbeat: z.literal(true) }).strict().parse(input);
    if (data.device_id !== this.env.PMA_INGEST_DEVICE_ID) throw new AppError('DEVICE_SCOPE_DENIED', 403);
    const now = new Date().toISOString();
    await this.store.db.prepare('INSERT INTO pma_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(`collector_last_seen:${data.device_id}`, now).run();
    let netease_crypto_runtime_ready = false;
    try { netease_crypto_runtime_ready = weapi({ runtime_probe: true }).encSecKey.length === 256 && eapi('/api/runtime-probe', { runtime_probe: true }).params.length > 0; } catch { /* A single platform's compatibility cannot break ingestion. */ }
    return { accepted: true, heartbeat: true, received_at: now, netease_crypto_runtime_ready, collector_control: await this.store.control('dandanplay') };
  }
}
