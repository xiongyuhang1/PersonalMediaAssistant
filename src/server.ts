import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { platforms, querySchema, syncSchema, ingestSchema, feedbackSchema, type Adapter, type Dataset, type Platform } from './contracts.js';
import { AppError, authorized, safeError } from './security.js';
import { Store } from './store.js';
import { SyncEngine } from './sync.js';
import type { BilibiliAdapter } from './adapters.js';

export interface ServerOptions { store: Store; adapters: Adapter[]; serviceToken: string; collectorToken?: string; collectorDeviceId?: string; }
export async function readJson(request: IncomingMessage, maxBytes = 1024 * 1024) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AppError('JSON_CONTENT_TYPE_REQUIRED', 415);
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw new AppError('BODY_TOO_LARGE', 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBytes) throw new AppError('BODY_TOO_LARGE', 413); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AppError('INVALID_JSON'); }
}
function send(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); }

export function createApp(options: ServerOptions) {
  if (options.serviceToken.length < 32 || (options.collectorToken && options.collectorToken === options.serviceToken)) throw new AppError('INVALID_SERVER_CREDENTIALS', 500);
  const { store } = options;
  const adapters = new Map(options.adapters.map(adapter => [adapter.platform, adapter]));
  const sync = new SyncEngine(store, options.adapters);
  const configured = () => Object.fromEntries(platforms.map(platform => [platform, platform === 'dandanplay' ? Boolean(options.collectorToken) : Boolean(adapters.get(platform)?.configured)])) as Record<Platform, boolean>;
  const cached = (platform: Platform, dataset: Dataset, args: Record<string, unknown> = {}) => {
    if (!store.state(platform, dataset)) throw new AppError(platform === 'dandanplay' ? 'LOCAL_SYNC_REQUIRED' : configured()[platform] ? 'SYNC_REQUIRED' : 'AUTH_REQUIRED', 409);
    const result = store.query(querySchema.parse({ ...args, platform, dataset }));
    const state = store.state(platform, dataset)!;
    return { ...result, status: state.state === 'synced' ? 'ok' : 'partial', source_status: { state: state.state, last_successful_sync_at: state.last_success, error_code: state.error_code }, source_account_modified: false };
  };
  const toolSchema = z.object({ name: z.string().min(1).max(80), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
  async function tool(name: string, args: Record<string, unknown>) {
    const mappings: Record<string, [Platform, Dataset]> = {
      steam_get_owned_games: ['steam', 'owned_games'], steam_get_recent_games: ['steam', 'recent_games'], bilibili_get_watch_history: ['bilibili', 'history'], bilibili_get_favorites: ['bilibili', 'favorites'],
      netease_get_recent_plays: ['netease', 'recent_plays'], netease_get_favorites: ['netease', 'favorites'],
      dandanplay_get_watchlist: ['dandanplay', 'watchlist'], dandanplay_get_watch_history: ['dandanplay', 'history'], dandanplay_get_episode_progress: ['dandanplay', 'episodes'],
    };
    if (mappings[name]) { const [platform, dataset] = mappings[name]; return cached(platform, dataset, args); }
    if (name === 'netease_get_user_record') {
      const { period, ...filters } = z.object({ period: z.enum(['all_time', 'this_week']).default('all_time') }).passthrough().parse(args);
      return cached('netease', period === 'all_time' ? 'user_record_all' : 'user_record_week', filters);
    }
    if (name === 'steam_get_profile_summary') {
      z.object({}).strict().parse(args);
      if (!store.state('steam', 'owned_games')) throw new AppError('SYNC_REQUIRED', 409);
      const summary = store.db.prepare("SELECT COUNT(*) AS owned_games,SUM(COALESCE(json_extract(payload,'$.playtime_minutes'),0)) AS cumulative_game_minutes FROM records WHERE platform='steam' AND dataset='owned_games'").get();
      return { schema_version: '1.0', summary, coverage: store.coverage('steam'), warnings: ['累计时长是投入证据，不等同于喜欢程度或完整历史会话。'] };
    }
    if (name === 'bilibili_search_videos') {
      const params = z.object({ keyword: z.string().trim().min(1).max(100), page: z.number().int().min(1).max(20).default(1) }).strict().parse(args);
      const adapter = adapters.get('bilibili') as BilibiliAdapter | undefined;
      if (!adapter || typeof adapter.search !== 'function') throw new AppError('UNSUPPORTED', 409);
      return adapter.search(params.keyword, params.page);
    }
    if (name === 'get_platform_sync_status') { z.object({}).strict().parse(args); return store.status(configured()); }
    if (name === 'get_data_coverage') { const params = z.object({ platform: z.enum(platforms).optional() }).strict().parse(args); return store.coverage(params.platform); }
    if (name === 'sync_platform_data') return sync.enqueue(syncSchema.parse(args));
    if (name === 'save_recommendation_feedback') return store.feedback(feedbackSchema.parse(args));
    throw new AppError('TOOL_NOT_IMPLEMENTED', 404);
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const ingest = url.pathname === '/v1/ingest/dandanplay' && request.method === 'POST';
      if (!authorized(request.headers.authorization, ingest ? options.collectorToken : options.serviceToken)) throw new AppError('UNAUTHORIZED', 401);
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { service: 'personal-media-assistant', version: '0.1.0', status: 'ok', instance_id: store.instanceId() });
      if (request.method === 'GET' && url.pathname === '/v1/status') return send(response, 200, store.status(configured()));
      if (request.method === 'GET' && url.pathname === '/v1/coverage') { const params = z.object({ platform: z.enum(platforms).optional() }).strict().parse(Object.fromEntries(url.searchParams)); return send(response, 200, store.coverage(params.platform)); }
      if (request.method === 'GET' && url.pathname === '/v1/records') return send(response, 200, store.query(querySchema.parse(Object.fromEntries(url.searchParams))));
      if (request.method === 'GET' && /^\/v1\/jobs\/[0-9a-f-]{36}$/.test(url.pathname)) return send(response, 200, sync.job(url.pathname.split('/').at(-1)!));
      if (request.method === 'POST' && url.pathname === '/v1/sync') return send(response, 202, sync.enqueue(syncSchema.parse(await readJson(request, 16384))));
      if (ingest) {
        const batch = ingestSchema.parse(await readJson(request));
        if (!options.collectorDeviceId || batch.device_id !== options.collectorDeviceId) throw new AppError('DEVICE_SCOPE_DENIED', 403);
        return send(response, 200, store.ingest(batch));
      }
      if (request.method === 'POST' && url.pathname === '/v1/feedback') return send(response, 200, store.feedback(feedbackSchema.parse(await readJson(request, 16384))));
      if (request.method === 'POST' && url.pathname === '/v1/tools/call') { const input = toolSchema.parse(await readJson(request, 16384)); return send(response, 200, await tool(input.name, input.arguments)); }
      throw new AppError('NOT_FOUND', 404);
    } catch (error) {
      const result = error instanceof z.ZodError ? new AppError('INVALID_ARGUMENTS') : safeError(error);
      send(response, result.http, { schema_version: '1.0', status: 'unavailable', error: { code: result.code } });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return { server, sync, tool, configured };
}
