// Local read-only connection diagnostic. Credentials arrive only through stdin.
// Output is restricted to safe codes, HTTP status and counts; no raw responses.
import { BilibiliAdapter, NeteaseAdapter, SteamAdapter } from '../apps/mcp-gateway/lib/cloud/adapters.ts';
import type { Adapter, Dataset } from '../apps/mcp-gateway/lib/cloud/contracts.ts';
import { AppError } from '../apps/mcp-gateway/lib/cloud/security.ts';

async function main() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 20000) throw new Error('INVALID_SETUP'); }
  const entries = JSON.parse(input); input = '';
  const allowed = ['STEAM_API_KEY', 'STEAM_ID', 'BILIBILI_COOKIE', 'NETEASE_COOKIE', 'NETEASE_UID'];
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).some(key => !allowed.includes(key)) || Object.values(entries).some(value => typeof value !== 'string' || value.length > 16000 || /[\r\n]/.test(value))) throw new Error('INVALID_SETUP');
  const settings = { steamKey: entries.STEAM_API_KEY, steamId: entries.STEAM_ID, biliCookie: entries.BILIBILI_COOKIE, neteaseCookie: entries.NETEASE_COOKIE, neteaseUid: entries.NETEASE_UID };
  const results = await Promise.all([
    ['steam', ['owned_games', 'recent_games']],
    ['bilibili', ['history', 'favorite_folders', 'favorites']],
    ['netease', ['favorites', 'recent_plays', 'user_record_all', 'user_record_week']],
  ].map(async ([platform, datasets]) => {
    let http_status: number | null = null;
    const fetcher: typeof fetch = async (input, init) => { const response = await fetch(input, init); http_status = response.status; return response; };
    const adapter: Adapter = platform === 'steam' ? new SteamAdapter(settings, fetcher) : platform === 'bilibili' ? new BilibiliAdapter(settings, fetcher) : new NeteaseAdapter(settings, fetcher);
    const checks = [];
    for (const dataset of datasets as Dataset[]) {
      http_status = null;
      try {
        const page = await adapter.page(dataset);
        checks.push({ dataset, status: 'ok', http_status, page_items: page.items.length, has_more: page.next_cursor !== undefined, snapshot: page.snapshot });
      } catch (error) { checks.push({ dataset, status: 'unavailable', code: error instanceof AppError ? error.code : 'UNEXPECTED_RESPONSE', http_status }); }
    }
    return { platform, checks };
  }));
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), scope: 'local_read_only_first_page_not_cloud_sync', results }));
}
main().catch(() => { console.log(JSON.stringify({ code: 'PROBE_FAILED' })); process.exitCode = 1; });
