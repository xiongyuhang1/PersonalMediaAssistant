import { resolve } from 'node:path';
import { SteamAdapter, BilibiliAdapter, NeteaseAdapter } from './adapters.js';
import { Store } from './store.js';
import { createApp } from './server.js';

const env = process.env;
if (!env.PMA_SERVICE_TOKEN || env.PMA_SERVICE_TOKEN.length < 32 || !env.PMA_CURSOR_SECRET || env.PMA_CURSOR_SECRET.length < 32) {
  console.error('PMA 配置缺失：先运行 npm run bootstrap，在本地配置安全令牌。'); process.exit(1);
}
const settings = { steamKey: env.STEAM_API_KEY, steamId: env.STEAM_ID, biliCookie: env.BILIBILI_COOKIE, neteaseUrl: env.NETEASE_API_URL, neteaseCookie: env.NETEASE_COOKIE, neteaseUid: env.NETEASE_UID };
const store = new Store(resolve(env.PMA_DATABASE ?? 'data/personal-media.sqlite'), env.PMA_CURSOR_SECRET);
const app = createApp({ store, adapters: [new SteamAdapter(settings), new BilibiliAdapter(settings), new NeteaseAdapter(settings)], serviceToken: env.PMA_SERVICE_TOKEN, collectorToken: env.PMA_COLLECTOR_TOKEN, collectorDeviceId: env.PMA_COLLECTOR_DEVICE_ID });
const port = Number(env.PMA_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PMA_PORT 无效'); process.exit(1); }
app.server.listen(port, env.PMA_HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ service: 'personal-media-assistant', port, status: 'listening', platforms_configured: app.configured() })));
let closing = false;
async function close() { if (closing) return; closing = true; app.server.close(); app.server.closeIdleConnections(); await app.sync.drain(); store.close(); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
