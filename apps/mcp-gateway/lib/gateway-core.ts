import { z } from 'zod';
import { MediaService, type CloudEnv } from './cloud/service.ts';
import { AppError } from './cloud/security.ts';
export const PLATFORMS = ['steam', 'bilibili', 'netease', 'dandanplay'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type GatewayConfig = CloudEnv;
export const SERVICE_VERSION = '0.7.1';
const filters = { keyword: { type: 'string', maxLength: 200 }, after: { type: 'string', format: 'date-time' }, before: { type: 'string', format: 'date-time' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, cursor: { type: 'string', maxLength: 1800 } };
const descriptor = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = [], write = false, destructive = false) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write || destructive, openWorldHint: true } });
export const tools = [
  descriptor('steam_get_achievements','按App查询官方成就及解锁比例。首次需refresh=true读取，之后可离线查询缓存；只读已同步游戏库中的游戏。全成就不等于剧情通关，隐藏未解锁成就默认隐藏详情；refresh不能与cursor并用。',{app_id:{type:'string',pattern:'^[1-9]\\d{0,9}$'},refresh:{type:'boolean',default:false},unlocked:{type:'boolean'},limit:filters.limit,cursor:filters.cursor},['app_id'],true),
  descriptor('refresh_work_metadata','从Steam官方商店读取已拥有游戏的原声关系；只在type=music且fullgame.appid一致时确认，并保留官方证据URL。不会仅凭标题确认网易云OST歌曲。24小时缓存，最多核验3个候选；可给已发现的candidate_app_ids，仍逐项核对官方归属。',{app_id:{type:'string',pattern:'^[1-9]\\d{0,9}$'},candidate_app_ids:{type:'array',minItems:1,maxItems:3,items:{type:'string',pattern:'^[1-9]\\d{0,9}$'}}},['app_id'],true),
  descriptor('netease_get_playlists','查询已同步的网易云歌单目录，区分本人创建和收藏；不是每首歌曲的喜欢断言。',filters),
  descriptor('netease_get_playlist_tracks','按歌单ID读取已同步的完整曲目分页。来自trackIds逐页读取，详情首屏不当作全量；需先同步playlist_tracks。',{playlist_id:{type:'string',pattern:'^\\d{1,20}$'},...filters},['playlist_id']),
  descriptor('netease_get_lyrics','按歌曲ID按需读取有界歌词片段或译文。没有歌词可能为纯音乐或不可用，不下载音频；offset为文本行号。',{song_id:{type:'string',pattern:'^\\d{1,20}$'},offset:{type:'integer',minimum:0,maximum:100000,default:0},limit:{type:'integer',minimum:1,maximum:10,default:3},translation:{type:'boolean',default:false}},['song_id']),
  descriptor('netease_get_listening_stats','查询已同步的周/月收听、总量和年度足迹。按用户接受的推定口径换算：周/月为分钟，总量/年度为秒；同时返回原始值、分钟/小时和inferred_user_accepted标记。不把年度足迹当完整年度报告。',filters),
  descriptor('bilibili_get_watch_later','查询本机已上传的稍后再看当前集合，不视为已观看或喜欢。',filters),
  descriptor('bilibili_get_followings','查询本机已上传的关注UP主列表；平台可见范围单独说明，不推断关注日期。',filters),
  descriptor('bilibili_get_subtitles','读取本机按需上传的视频字幕；未缓存时可排队等本机下次同步。默认只读第一P，指定cid读取相应分P；可指定语言。离线电脑不能立即读取新字幕，不把字幕秒数当观看时间。',{bvid:{type:'string',pattern:'^BV[A-Za-z0-9]{10}$'},cid:{type:'string',pattern:'^\\d{1,20}$'},language:{type:'string',maxLength:30},request_if_missing:{type:'boolean',default:true},limit:filters.limit,cursor:filters.cursor},['bvid'],true),
  descriptor('bilibili_get_recent_interactions','查询本机已上传的最近点赞或投币窗口。action=like/coin；点赞接口未提供点赞时间，不能用视频发布时间代替；投币时间与本人投币数量单独表达，不保证全部历史。支持关键词和分页。',{action:{type:'string',enum:['like','coin']},...filters},['action']),
  descriptor('get_service_health', '检查 Sites 云端入口、持久数据库和运行实例；不读取平台历史。'),
  descriptor('get_platform_sync_status', '查看四个平台每个数据集的真实同步状态和最后成功时间。未同步不是没有记录。', { platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS }, minItems: 1, maxItems: 4, uniqueItems: true } }),
  descriptor('get_data_coverage', '查询已同步数据的可观察时间范围和缺口，不能据此宣称完整历史。', { platform: { type: 'string', enum: PLATFORMS } }),
  descriptor('get_cross_platform_timeline', '按真实时间倒序分页查询跨平台记录，必须指定起止时间；分别标注最后观察、有日期收藏、待核对最近列表、当前状态采集、排行采集和Steam每日样本。无日期完成状态不生成观看时间，排行不是逐次播放。当前状态仅保留最近采集；需要行为时间时显式选择last_observation/collection轨道。', { after: { type: 'string', format: 'date-time' }, before: { type: 'string', format: 'date-time' }, platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS }, minItems: 1, maxItems: 4 }, lanes: { type: 'array', items: { type: 'string', enum: ['last_observation','collection','platform_interaction','unverified_recent_list','collection_snapshot','ranking_snapshot','library_sample'] }, minItems: 1, maxItems: 7 }, keyword: filters.keyword, limit: filters.limit, cursor: filters.cursor }, ['after','before']),
  descriptor('steam_get_playtime_history', '按AppID查询本服务从部署后开始采集的UTC每日累计时长样本，返回相邻采样差值。仅在完整游戏库同步后保存每日最后样本，不回溯、不制造游戏会话，计数回退时不计算负时长。', { app_id: { type: 'string', pattern: '^\\d{1,20}$' }, after: filters.after, before: filters.before, limit: filters.limit, cursor: filters.cursor }, ['app_id']),
  descriptor('prepare_personal_data_deletion', '只有用户要求删除本服务个人数据时调用。只预览指定平台或全部平台的缓存、反馈与时长样本数量，返回10分钟有效的确认令牌和确认文字；本工具不删除。必须让用户先审阅范围，再按其明确指示调用delete_personal_data。', { scope: { type: 'string', enum: [...PLATFORMS,'all'] } }, ['scope']),
  descriptor('delete_personal_data', '仅在用户已审阅预览并明确确认删除其指定范围后调用。使用预览令牌及其确认文字；删除云端媒体缓存、反馈、样本、游标并暂停相关来源同步，防止自动回填。不修改平台账号、弹弹play源库、已下载文件或Sites凭据。不要为测试而删除真实数据。', { scope: { type: 'string', enum: [...PLATFORMS,'all'] }, token: { type: 'string', maxLength: 1800 }, confirmation: { type: 'string', maxLength: 40 } }, ['scope','token','confirmation'], true, true),
  descriptor('resume_platform_sync', '仅在用户明确要求恢复某个平台同步时调用。解除删除操作留下的同步暂停；后续平台卡片/MCP可重新同步，弹弹play须本机采集器在线重新上传。不修改源账号。', { platform: { type: 'string', enum: PLATFORMS } }, ['platform'], true),
  descriptor('export_personal_data', '生成需要同一ChatGPT账号登录的私有JSONL下载链接，导出已同步记录和显式反馈，不在聊天返回全量历史。文件末行标明是否完整及续页链接；不导出凭据或原始数据库。', { platform: { type: 'string', enum: PLATFORMS }, cursor: { type: 'string', maxLength: 1800 }, max_records: { type: 'integer', minimum: 1, maximum: 2000, default: 2000 } }),
  descriptor('analyze_cross_platform_interests', '按音乐/游戏/动画/综合问题选择所需平台，返回有界事实摘要、少量证据和缺失来源；不把时长或收藏当作喜欢，不凭标题制造作品关联。音乐默认只查网易云与B站，需要游戏OST或动画音乐时再指定额外来源。', { focus: { type: 'string', enum: ['overview', 'games', 'music', 'anime'], default: 'overview' }, include_game_ost: { type: 'boolean', default: false }, include_anime_music: { type: 'boolean', default: false } }),
  descriptor('search_related_media', '在已同步的四个平台缓存中按标题、专辑或艺人检索关联候选，先过滤再限量返回。跨平台匹配保持未确认，同平台内容ID、网易云专辑ID及已核验Steam官方原声关系分别标注证据。其他跨平台同名保持候选。', { query: { type: 'string', minLength: 1, maxLength: 100 }, source_platform: { type: 'string', enum: PLATFORMS }, source_id: { type: 'string', minLength: 1, maxLength: 100 }, target_types: { type: 'array', items: { type: 'string', enum: ['game', 'video', 'music', 'anime'] }, minItems: 1, maxItems: 4 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, ['query']),
  descriptor('get_work_related_content', '从已同步作品出发查相关缓存。work_ref例steam:570、netease:123、dandanplay:456、bilibili:BVxxxxxxxxxx。标题关联保持候选；已核验的官方原声和相同专辑ID可确认相应关系。歌词与字幕使用专门工具。', { work_ref: { type: 'string', pattern: '^(steam|bilibili|netease|dandanplay):[A-Za-z0-9_-]{1,100}$' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, ['work_ref']),
  descriptor('recommend_bilibili_videos', '结合Steam、B站、网易云和弹弹play已同步证据生成检索词，实时搜索并核对真实视频详情。按BV排除全部匹配缓存与最新明确负面/已看/收藏反馈，结合质量信号、新鲜度和创作者多样性排序并保留探索方向。历史未同步时明确不能保证未看过；风控/限流后停止并冷却10分钟。显式偏好上下文优先，只传可用于平台检索的兴趣关键词，不传日记或身份信息；服务不直接读取Memory。', { limit: { type: 'integer', minimum: 5, maximum: 10, default: 8 }, preference_hints: { type: 'array', maxItems: 5, items: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 100 }, origin: { type: 'string', enum: ['user_statement', 'chat_memory_context'] } }, required: ['text', 'origin'], additionalProperties: false } }, exclude_topics: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 } }, exploration_ratio: { type: 'number', minimum: 0, maximum: 0.5, default: 0.25 } }),
  descriptor('sync_platform_data', '按需从平台读取并提交一页到云端缓存，返回 has_more 时再次调用以继续；弹弹play须等本机推送。只写本服务，不修改平台账号。', { platform: { type: 'string', enum: PLATFORMS }, dataset: { type: 'string', enum: ['owned_games', 'recent_games', 'history', 'favorite_folders', 'favorites', 'user_record_all', 'user_record_week', 'recent_plays', 'playlists', 'playlist_tracks', 'listening_stats', 'achievements', 'related_works'] }, app_id:{type:'string',pattern:'^[1-9]\\d{0,9}$'}, candidate_app_ids:{type:'array',minItems:1,maxItems:3,items:{type:'string',pattern:'^[1-9]\\d{0,9}$'}}, restart_cursor: { type: 'boolean', default: false } }, ['platform', 'dataset'], true),
  descriptor('steam_get_profile_summary', '汇总已同步的游戏库与累计投入；时长不等于喜欢程度，也不是会话日志。'),
  descriptor('steam_get_owned_games', '分页查询已同步的 Steam 游戏库、AppID 与累计分钟数。', filters),
  descriptor('steam_get_recent_games', '查询已同步的 Steam 近期游戏聚合，不提供逐场会话。', filters),
  descriptor('bilibili_get_watch_history', '按日期、关键词、UP主、分区和标题规则内容类型，过滤已同步的B站最后观看观察。', { ...filters, uploader_id: { type: 'string' }, category_id: { type: 'string' }, content_type: { type: 'string' } }),
  descriptor('bilibili_get_favorites', '分页查询已同步的B站收藏，收藏与明确喜欢分别表达。', { ...filters, uploader_id: { type: 'string' }, category_id: { type: 'string' }, content_type: { type: 'string' } }),
  descriptor('bilibili_search_videos', '实时检索真实B站视频候选；结果不是用户收藏或已观看记录。', { keyword: { type: 'string', minLength: 1, maxLength: 100 }, page: { type: 'integer', minimum: 1, maximum: 20, default: 1 } }, ['keyword']),
  descriptor('netease_get_user_record', '读取已同步的全时间/本周听歌排行；score 不伪装为播放次数。', { ...filters, period: { type: 'string', enum: ['all_time', 'this_week'], default: 'all_time' } }),
  descriptor('netease_get_recent_plays', '读取网易云最近播放列表；缺少真实播放时间就不制造事件。', filters),
  descriptor('netease_get_favorites', '读取已同步红心歌曲、歌曲ID和元数据，不修改红心状态。', filters),
  descriptor('dandanplay_get_watchlist', '按关注、未看完/已看完/放弃、个人评分过滤番剧。FavoriteStatus=0仅代表未看完，1代表全部看完（即使无日期），2代表放弃；缺失保持未知。个人评分10=非常好看、8=挺好看的、6=勉强能看下去，0为未评分（用rating_state=unrated查询）。社区评分分开。', { ...filters, following: { type: 'boolean' }, completion_state: { type: 'string', enum: ['unknown', 'not_completed', 'completed', 'abandoned'] }, user_rating: { type: 'number', exclusiveMinimum: 0, maximum: 10 }, rating_state: { type: 'string', enum: ['rated', 'unrated', 'unknown'] } }),
  descriptor('dandanplay_get_watch_history', '查询分集最后观看观察；不把上映、资料刷新或采集时间当观看时间。', filters),
  descriptor('dandanplay_get_episode_progress', '按番剧ID查分集记录。明确已看完但无日期时保留完成断言，不虚构日期。', { ...filters, anime_id: { type: 'string' }, episode_id: { type: 'string' } }, ['anime_id']),
  descriptor('save_recommendation_feedback', '保存用户明确的喜欢、不喜欢、已看、已收藏或不准确反馈；不会修改平台账号。', { request_id: { type: 'string', minLength: 8, maxLength: 100 }, platform: { type: 'string', enum: PLATFORMS }, content_id: { type: 'string' }, feedback: { type: 'string', enum: ['like', 'dislike', 'seen', 'saved', 'inaccurate'] }, reason: { type: 'string', maxLength: 1000 } }, ['request_id', 'platform', 'content_id', 'feedback'], true),
];
export async function gatewayHealth(config: GatewayConfig) {
  if (!config.DB || !config.PMA_CURSOR_KEY) return { schema_version: '1.0', service: 'personal-media-assistant', version: SERVICE_VERSION, gateway_status: 'ok', backend_status: 'not_configured', storage: 'sites_d1', checked_at: new Date().toISOString() };
  const service = new MediaService(config);
  return { schema_version: '1.0', service: 'personal-media-assistant', version: SERVICE_VERSION, gateway_status: 'ok', backend_status: 'connected', backend_instance: await service.store.instance(), storage: 'sites_d1', checked_at: new Date().toISOString() };
}
export async function gatewayStatus(config: GatewayConfig, platforms: Platform[]) {
  try { const service = new MediaService(config); const status = await service.store.status(service.configured()); return { ...status, platforms: status.platforms.filter(p => platforms.includes(p.platform)) }; }
  catch { return { schema_version: '1.0', status: 'unavailable', platforms: platforms.map(platform => ({ platform, state: 'unavailable', records: null, last_successful_sync_at: null })) }; }
}
export async function limitedText(request: Request, limit = 131072) {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new AppError('BODY_TOO_LARGE', 413);
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) { await reader.cancel(); throw new AppError('BODY_TOO_LARGE', 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function handleMcp(body: unknown, userId: string | null, config: GatewayConfig) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { http: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  const request = body as { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  const id = typeof request.id === 'string' || typeof request.id === 'number' || request.id === null ? request.id : null;
  const reply = (result: unknown) => ({ http: 200, body: { jsonrpc: '2.0', id, result } });
  const error = (code: number, message: string, http = 200) => ({ http, body: { jsonrpc: '2.0', id, error: { code, message } } });
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid Request', 400);
  if (request.method.startsWith('notifications/')) return { http: 204, body: null };
  if (request.id === undefined) return error(-32600, 'Request id required', 400);
  if (request.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'personal-media-assistant', version: SERVICE_VERSION } });
  if (request.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'personal-media-assistant', version: SERVICE_VERSION }, instructions: '数据来自账号平台或已同步缓存；未查询/未同步不能当作没有记录。' });
  if (request.method === 'tools/list') return reply({ tools });
  if (request.method === 'ping') return reply({});
  if (request.method !== 'tools/call') return error(-32601, 'Method not found');
  if (!userId) return error(-32001, 'Sign in with ChatGPT required', 401);
  try {
    if (!request.params?.name || !tools.some(t => t.name === request.params!.name)) return error(-32602, 'Unknown tool');
    const service = new MediaService(config); await service.store.owner(userId);
    const args = z.record(z.string(), z.unknown()).parse(request.params.arguments ?? {});
    const result = request.params.name === 'get_service_health' ? (z.object({}).strict().parse(args), await gatewayHealth(config)) : await service.call(request.params.name, args);
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) { const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'SERVICE_UNAVAILABLE'; return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', code, ...(error instanceof AppError && error.upstream ? { upstream: error.upstream } : {}) }) }], isError: true }); }
}
