import { BiliClient } from '../../vendor/bilibili/src/http.ts';
import { type Adapter, type Dataset, type MediaRecord, type Page, recordSchema } from './contracts.ts';
import { AppError, hash } from './security.ts';
import { neteaseRequest } from './netease-transport.ts';
import { neteaseExtraPage,songMetadata } from './netease-extra.ts';
import { biliExtraPage } from './bilibili-extra.ts';
import { biliObservedFetch, type BiliDiagnostic } from './bilibili-transport.ts';

export type Settings = { steamKey?: string; steamId?: string; biliCookie?: string; neteaseUrl?: string; neteaseCookie?: string; neteaseUid?: string };
const string = (v: unknown, max = 300) => typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const timestamp = (v: unknown, unit: 'seconds' | 'milliseconds' = 'seconds') => {
  const n = number(v); if (!n) return undefined;
  const ms = n * (unit === 'seconds' ? 1000 : 1);
  return ms >= Date.UTC(2000, 0, 1) && ms <= Date.now() + 86400000 ? new Date(ms).toISOString() : undefined;
};
const textTitle = (v: unknown) => string(v, 600).replace(/<\/?(?:em|span|b|strong|i|mark)(?:\s[^>]*)?>/gi, '').trim();
function object(v: unknown): Record<string, any> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('UPSTREAM_CHANGED', 502); return v as Record<string, any>; }
function array(v: unknown): any[] { if (!Array.isArray(v)) throw new AppError('UPSTREAM_CHANGED', 502); return v; }
function record(value: Omit<MediaRecord, 'collected_at'>): MediaRecord { const result = recordSchema.safeParse({ ...value, collected_at: new Date().toISOString() }); if (!result.success) throw new AppError('UPSTREAM_CHANGED', 502); return result.data; }

export function classify(title: string): string[] {
  const rules: Array<[RegExp, string]> = [[/OST|原声|soundtrack/i, 'game_ost'], [/\bOP\b|片头/i, 'anime_op'], [/\bED\b|片尾/i, 'anime_ed'], [/AMV|MAD/i, 'amv_mad'], [/\bMV\b|音乐视频/i, 'music_mv'], [/实况|流程|通关|速通/i, 'gameplay'], [/二创|同人/i, 'game_fanwork'], [/剧情.*解析|剧情分析/i, 'story_analysis'], [/角色.*分析/i, 'character_analysis'], [/科技|数码|硬件/i, 'technology'], [/科普|科学/i, 'science']];
  return rules.filter(([rule]) => rule.test(title)).map(([, type]) => type).slice(0, 6);
}

export function safeFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    try {
      // Workers rejects redirect:'error' before sending a request. Manual mode
      // retains credential boundaries: every redirect is rejected below.
      const result = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), redirect: 'manual' });
      if (result.status >= 300 && result.status < 400) throw new AppError('UPSTREAM_REDIRECT_BLOCKED', 502);
      if (!result.ok) throw new AppError(result.status === 401 ? 'AUTH_EXPIRED' : result.status === 429 ? 'RATE_LIMITED' : result.status === 412 ? 'RISK_CONTROLLED' : 'UPSTREAM_UNAVAILABLE', 502);
      return result;
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError('UPSTREAM_UNAVAILABLE', 502); }
  };
}

export class SteamAdapter implements Adapter {
  platform = 'steam' as const; datasets: Dataset[] = ['owned_games', 'recent_games']; configured: boolean;
  settings: Settings; fetcher: typeof fetch;
  constructor(settings: Settings, fetcher: typeof fetch = fetch) { this.settings = settings; this.configured = Boolean(settings.steamKey && /^\d{17}$/.test(settings.steamId ?? '')); this.fetcher = safeFetch(fetcher); }
  async page(dataset: Dataset): Promise<Page> {
    if (!this.configured) throw new AppError('AUTH_REQUIRED', 409);
    if (!this.datasets.includes(dataset)) throw new AppError('UNSUPPORTED', 400);
    const owned = dataset === 'owned_games';
    const url = new URL(`https://api.steampowered.com/IPlayerService/${owned ? 'GetOwnedGames' : 'GetRecentlyPlayedGames'}/v0001/`);
    url.search = new URLSearchParams({ steamid: this.settings.steamId!, ...(owned ? { include_appinfo: 'true', include_played_free_games: 'true' } : { count: '0' }) }).toString();
    const response = object(object(await (await this.fetcher(url, { headers: { 'x-webapi-key': this.settings.steamKey! } })).json()).response);
    const expectedCount = number(response[owned ? 'game_count' : 'total_count']);
    if (expectedCount === undefined) throw new AppError('PERMISSION_OR_DATA_UNAVAILABLE', 502);
    const games = expectedCount === 0 && response.games === undefined ? [] : array(response.games);
    if (games.length !== expectedCount) throw new AppError('UPSTREAM_INCOMPLETE', 502);
    return { snapshot: true, items: games.map(g => {
      const id = string(g.appid, 30);
      return record({ platform: 'steam', dataset, id, content_id: id, title: textTitle(g.name), record_kind: 'library_snapshot', playtime_minutes: number(g.playtime_forever), recent_playtime_minutes: number(g.playtime_2weeks), url: `https://store.steampowered.com/app/${id}/` });
    }), coverage_note: '平台当前可见的游戏快照；累计时长不是游戏会话，首次采集前的历史不可还原。' };
  }
}

export class BilibiliAdapter implements Adapter {
  platform = 'bilibili' as const; datasets: Dataset[] = ['history', 'favorite_folders', 'favorites', 'likes', 'coins', 'watch_later', 'followings']; configured: boolean; client: BiliClient;
  private lastDiagnostic?: BiliDiagnostic;
  constructor(settings: Settings, fetcher: typeof fetch = fetch, options: { observe?: (diagnostic: BiliDiagnostic) => void; standardHeaders?: boolean } = {}) {
    const config = { cookie: settings.biliCookie ?? '', allowWrite: false, downloadDir: '', ffmpeg: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' };
    this.client = new BiliClient(config, safeFetch(biliObservedFetch(fetcher, diagnostic => { this.lastDiagnostic = diagnostic; options.observe?.(diagnostic); }, options.standardHeaders))); this.configured = this.client.loggedIn;
  }
  async json(path: string, query?: Record<string, string | number | boolean | undefined>, wbi = false): Promise<any> {
    this.lastDiagnostic = undefined;
    try { return await this.client.json(`https://api.bilibili.com${path}`, { query, wbi }); }
    catch (error) {
      // The transport callback may update this during the awaited client call.
      const diagnostic = this.lastDiagnostic as BiliDiagnostic | undefined;
      if (error instanceof AppError) throw new AppError(error.code, error.http, diagnostic);
      const code = (error as { code?: number }).code ?? diagnostic?.business_code;
      throw new AppError(code === -101 ? 'AUTH_EXPIRED' : code === -352 || code === -412 ? 'RISK_CONTROLLED' : code === -403 ? 'PERMISSION_DENIED' : 'UPSTREAM_UNAVAILABLE', 502, diagnostic);
    }
  }
  video(v: any, dataset: Dataset, id?: string): MediaRecord {
    const bvid = string(v.bvid ?? v.history?.bvid, 30);
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new AppError('UPSTREAM_CHANGED', 502);
    const title = textTitle(v.title);
    return record({ platform: 'bilibili', dataset, id: id ?? bvid, content_id: bvid, title, record_kind: dataset === 'history' ? 'last_watch_observation' : dataset === 'search_results' ? 'media_candidate' : 'collection_state', url: `https://www.bilibili.com/video/${bvid}`, uploader_id: string(v.author_mid ?? v.upper?.mid ?? v.mid, 64) || undefined, uploader_name: string(v.author_name ?? v.upper?.name ?? v.author, 160) || undefined, category_id: string(v.tagid ?? v.tid ?? v.typeid, 64) || undefined, content_types: classify(title), published_at: timestamp(v.pubdate), source_time: dataset === 'search_results' ? undefined : timestamp(dataset === 'history' ? v.view_at : v.fav_time), source_time_semantics: dataset === 'history' ? 'last_watch' : dataset === 'search_results' ? 'unknown' : 'collection_time' });
  }
  async folders() {
    const me = object(await this.json('/x/web-interface/nav'));
    if (!string(me.mid)) throw new AppError('AUTH_EXPIRED', 502);
    const data = object(await this.json('/x/v3/fav/folder/created/list-all', { up_mid: string(me.mid) }));
    return array(data.list);
  }
  async page(dataset: Dataset, cursor?: unknown): Promise<Page> {
    if (!this.configured) throw new AppError('AUTH_REQUIRED', 409);
    if (dataset === 'watch_later' || dataset === 'followings') return biliExtraPage(this,dataset,cursor);
    if (dataset === 'likes' || dataset === 'coins') {
      const me = object(await this.json('/x/web-interface/nav'));
      if (me.isLogin !== true || !string(me.mid)) throw new AppError('AUTH_EXPIRED', 502);
      const data = await this.json(dataset === 'likes' ? '/x/space/like/video' : '/x/space/coin/video', { vmid: string(me.mid) });
      const list = dataset === 'likes' ? array(object(data).list) : array(data);
      return { snapshot: true, items: list.filter(v => v.state === 0 && /^BV[A-Za-z0-9]{10}$/.test(string(v.bvid))).map((v, i) => {
        const base = this.video({ ...v, upper: v.owner }, dataset);
        const time = dataset === 'coins' ? timestamp(v.time) : undefined;
        return record({ ...base, record_kind: 'interaction_state', interaction: dataset === 'likes' ? 'like' : 'coin', source_order: i + 1, source_time: time, source_time_semantics: time ? 'coin_time' : 'unknown', coins_given: dataset === 'coins' && [1,2].includes(v.coins) ? v.coins : undefined });
      }), coverage_note: dataset === 'likes' ? '平台最近点赞窗口；实测返回list，不提供点赞时间或续页。pubdate/ctime不是点赞时间，不代表全部点赞历史。' : '平台最近投币窗口；time保留为投币时间，coins为本人本条投币数量，不使用stat.coin全站计数。无续页，不代表全部投币历史。' };
    }
    if (dataset === 'history') {
      const c = cursor ? object(cursor) : {};
      const data = object(await this.json('/x/web-interface/history/cursor', { ps: 20, max: c.max, view_at: c.view_at, type: 'archive' }));
      const list = array(data.list);
      const next = data.cursor?.max;
      return { items: list.filter(v => v.history?.bvid).map(v => this.video(v, dataset, `${v.history.bvid}:${string(v.history.cid) || 'main'}`)), snapshot: false, next_cursor: next && list.length ? { max: next, view_at: data.cursor.view_at } : undefined, coverage_note: '平台当前可见历史窗口；按 BV/分 P 保存最后观看观察，不证明全部历史或每次重看。内容类型来自标题规则，属于候选分类。' };
    }
    if (dataset === 'favorite_folders') return { snapshot: true, items: (await this.folders()).map(f => record({ platform: 'bilibili', dataset, id: string(f.id), content_id: string(f.id), title: textTitle(f.title), record_kind: 'collection_state' })) };
    if (dataset !== 'favorites') throw new AppError('UNSUPPORTED');
    const c = cursor ? object(cursor) : { folders: (await this.folders()).map(f => string(f.id)), index: 0, page: 1 };
    if (!Array.isArray(c.folders) || !Number.isInteger(c.index) || !Number.isInteger(c.page)) throw new AppError('UPSTREAM_CHANGED', 502);
    if (c.index >= c.folders.length) return { snapshot: true, items: [] };
    const folder = c.folders[c.index];
    const data = object(await this.json('/x/v3/fav/resource/list', { media_id: folder, pn: c.page, ps: 20, platform: 'web' }));
    if (typeof data.has_more !== 'boolean') throw new AppError('UPSTREAM_CHANGED', 502);
    const media = data.medias == null && data.has_more === false && data.info?.media_count === 0 ? [] : array(data.medias);
    const items = media.filter(v => /^BV[A-Za-z0-9]{10}$/.test(string(v.bvid)) && v.attr !== 9 && v.title !== '已失效视频').map(v => this.video(v, dataset, `${folder}:${v.bvid}`));
    const next = data.has_more ? { ...c, page: c.page + 1 } : c.index + 1 < c.folders.length ? { ...c, index: c.index + 1, page: 1 } : undefined;
    return { snapshot: true, items, next_cursor: next, coverage_note: '已登录账号当前收藏夹快照；失效视频未作为可推荐候选。' };
  }
  async search(keyword: string, page = 1): Promise<{ items: MediaRecord[]; has_more: boolean | null; warnings: string[]; skipped_results?: number }> {
    const data = object(await this.json('/x/web-interface/wbi/search/type', { search_type: 'video', keyword, page, order: 'totalrank' }, true));
    const results = data.result == null && data.numResults === 0 ? [] : array(data.result);
    // The live response can interleave live-room cards with empty BV IDs even
    // for search_type=video. Keep only identifiable video candidates.
    const videos = results.filter(v => /^BV[A-Za-z0-9]{10}$/.test(string(v.bvid, 30)));
    return { items: videos.map(v => this.video(v, 'search_results')), skipped_results: results.length - videos.length, has_more: number(data.numPages) !== undefined ? page < data.numPages : null, warnings: ['检索结果来自实时平台搜索；跳过不含有效BV的视频外卡片。标题规则分类未经人工确认，结果不代表已收藏。'] };
  }
  async details(bvid: string): Promise<MediaRecord> {
    if (!/^BV[A-Za-z0-9]{10}$/.test(bvid)) throw new AppError('INVALID_VIDEO_ID');
    const data = object(await this.json('/x/web-interface/wbi/view', { bvid }, true));
    if (data.bvid !== bvid || data.state !== 0) throw new AppError('CONTENT_UNAVAILABLE', 502);
    const item = this.video({ ...data, upper: data.owner }, 'search_results');
    const stat = object(data.stat);
    return record({ ...item, description: string(data.desc, 1200), duration_ms: number(data.duration) === undefined ? undefined : data.duration * 1000, quality: { views: number(stat.view), likes: number(stat.like), coins: number(stat.coin), favorites: number(stat.favorite) } });
  }
}

export function mapNeteaseRanking(value: unknown, dataset: 'user_record_all' | 'user_record_week'): MediaRecord[] {
  return array(value).map((entry, index) => {
    const song = object(entry.song); const id = string(song.id, 40);
    return record({ platform: 'netease', dataset, id, content_id: id, title: textTitle(song.name), record_kind: dataset === 'user_record_all' ? 'lifetime_ranking' : 'period_statistic', ...songMetadata(song), rank: index + 1, rank_score: number(entry.score), play_count: number(entry.playCount), artists: Array.isArray(song.ar) ? song.ar.map((a: any) => string(a.name, 160)).filter(Boolean).slice(0, 30) : [], album: string(song.al?.name, 300) || undefined, url: `https://music.163.com/#/song?id=${id}` });
  });
}
export function mapNeteaseRecent(value: unknown): MediaRecord[] {
  return array(value).map(entry => {
    const song = object(entry.data); const id = string(song.id, 40); const time = timestamp(entry.playTime, 'milliseconds');
    return record({ platform: 'netease', dataset: 'recent_plays', id: `${id}:${time ?? 'undated'}`, content_id: id, title: textTitle(song.name), record_kind: 'recent_play_list_item', ...songMetadata(song), source_time: time, source_time_semantics: time ? 'recent_list_time_unverified' : 'unknown', artists: Array.isArray(song.ar) ? song.ar.map((a: any) => string(a.name, 160)).filter(Boolean).slice(0, 30) : [], url: `https://music.163.com/#/song?id=${id}` });
  });
}
export class NeteaseAdapter implements Adapter {
  platform = 'netease' as const; datasets: Dataset[] = ['favorites', 'recent_plays', 'user_record_all', 'user_record_week', 'playlists', 'playlist_tracks', 'listening_stats']; configured: boolean;
  settings: Settings; fetcher: typeof fetch;
  constructor(settings: Settings, fetcher: typeof fetch = fetch) { this.settings = settings; this.configured = Boolean(settings.neteaseCookie && settings.neteaseUid); this.fetcher = safeFetch(fetcher); }
  async call(path: Parameters<typeof neteaseRequest>[0], params: Record<string, unknown>) {
    if (!this.configured) throw new AppError('AUTH_REQUIRED', 409);
    const result = object(await neteaseRequest(path, params, this.settings.neteaseCookie!, this.fetcher));
    if (result.code !== 200) throw new AppError([301, 302].includes(result.code) ? 'AUTH_EXPIRED' : result.code === 403 ? 'PERMISSION_DENIED' : 'UPSTREAM_UNAVAILABLE', 502);
    return result;
  }
  async page(dataset: Dataset, cursor?: unknown): Promise<Page> {
    if (['playlists','playlist_tracks','listening_stats'].includes(dataset)) return neteaseExtraPage(this,dataset,cursor);
    if (dataset === 'user_record_all' || dataset === 'user_record_week') {
      const all = dataset === 'user_record_all'; const data = await this.call('/user/record', { uid: this.settings.neteaseUid, type: all ? 0 : 1 });
      return { snapshot: true, items: mapNeteaseRanking(data[all ? 'allData' : 'weekData'], dataset), coverage_note: '平台当前返回的排行快照；score 保持排行分数，只有实际 playCount 字段才作为次数，不构造播放事件或完整历史。' };
    }
    if (dataset === 'recent_plays') {
      const result = await this.call('/record/recent/song', { limit: 100 });
      return { snapshot: true, items: mapNeteaseRecent(object(result.data).list), coverage_note: '最近播放列表；请求limit=100，但平台可返回更多，按实际响应有界提交。playTime 保留为待核对的列表时间，不视为独立事件；忽略 updateTime 等替代字段。' };
    }
    if (dataset !== 'favorites') throw new AppError('UNSUPPORTED');
    const offset = cursor === undefined ? 0 : object(cursor).offset;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('UPSTREAM_CHANGED', 502);
    const liked = array((await this.call('/likelist', { uid: this.settings.neteaseUid })).ids);
    const digest = hash(JSON.stringify(liked));
    if (cursor !== undefined && object(cursor).digest !== digest) throw new AppError('SNAPSHOT_CHANGED_RESTART_REQUIRED', 409);
    const ids = liked.slice(offset, offset + 100);
    const data = ids.length ? await this.call('/song/detail', { ids: ids.map(v => string(v)).join(',') }) : { songs: [] };
    return { snapshot: true, items: array(data.songs).map(song => { const id = string(song.id, 40); return record({ platform: 'netease', dataset, id, content_id: id, title: textTitle(song.name), record_kind: 'collection_state', ...songMetadata(song), artists: Array.isArray(song.ar) ? song.ar.map((a: any) => string(a.name, 160)).filter(Boolean).slice(0, 30) : [], album: string(song.al?.name, 300) || undefined, duration_ms: number(song.dt), url: `https://music.163.com/#/song?id=${id}` }); }), next_cursor: offset + ids.length < liked.length ? { offset: offset + ids.length, digest } : undefined, coverage_note: '红心集合快照；收藏不等同于喜欢判断或真实播放。歌单变动导致签名不一致时须重新开始同步。' };
  }
}
