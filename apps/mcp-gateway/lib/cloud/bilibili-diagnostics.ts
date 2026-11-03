import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { BilibiliAdapter, safeFetch } from './adapters.ts';
import { biliObservedFetch, type BiliDiagnostic } from './bilibili-transport.ts';
import { parseCookie } from '../../vendor/bilibili/src/config.ts';
import { AppError } from './security.ts';
import type { CloudEnv } from './service.ts';

export const biliProbeSchema = z.object({ group: z.enum(['baseline', 'history', 'controls']), salt: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
type ProbeInput = z.infer<typeof biliProbeSchema>;
const terminal = (code: string) => ['RISK_CONTROLLED', 'RATE_LIMITED', 'AUTH_EXPIRED', 'UPSTREAM_UNAVAILABLE', 'DIAGNOSTIC_BUDGET_REACHED'].includes(code);

export async function runBilibiliProbe(cookie: string, input: ProbeInput, fetcher: typeof fetch = fetch) {
  const parts = parseCookie(cookie); const requests: BiliDiagnostic[] = []; const checks: Record<string, unknown>[] = [];
  const deadline = Date.now() + 30000; let count = 0;
  const bounded: typeof fetch = (url, init) => {
    if (++count > 8 || Date.now() >= deadline) throw new AppError('DIAGNOSTIC_BUDGET_REACHED', 429);
    return fetcher(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
  };
  const client = new BilibiliAdapter({ biliCookie: cookie }, bounded, { observe: d => requests.push(d) });
  let stopped = false;
  const check = async (name: string, action: () => Promise<Record<string, unknown>>, independent = false) => {
    if (stopped && !independent) { checks.push({ name, status: 'skipped' }); return; }
    try { checks.push({ name, status: 'ok', ...await action() }); }
    catch (error) { const code = error instanceof AppError ? error.code : 'UPSTREAM_CHANGED'; checks.push({ name, status: 'unavailable', code }); if (terminal(code)) stopped = true; }
  };
  if (input.group === 'controls') {
    // Two independent controls, one request each when a provider buvid is present.
    await check('anonymous_nav', async () => {
      const headers = new Headers(client.client.baseHeaders); headers.delete('Cookie');
      const transport = safeFetch(biliObservedFetch(bounded, d => requests.push(d)));
      const body: any = await (await transport('https://api.bilibili.com/x/web-interface/nav', { headers })).json();
      return { is_login: body?.data?.isLogin === true, business_code: typeof body?.code === 'number' ? body.code : null, wbi_keys_present: Boolean(body?.data?.wbi_img?.img_url && body?.data?.wbi_img?.sub_url) };
    }, true);
    await check('standard_accept_headers_nav', async () => {
      const standard = new BilibiliAdapter({ biliCookie: cookie }, bounded, { observe: d => requests.push(d), standardHeaders: true });
      const data = await standard.json('/x/web-interface/nav'); return { is_login: data?.isLogin === true, wbi_keys_present: Boolean(data?.wbi_img?.img_url && data?.wbi_img?.sub_url) };
    }, true);
  } else if (input.group === 'history') {
    await check('history', async () => ({ items: (await client.page('history')).items.length }));
  } else {
    await check('nav', async () => { const data = await client.json('/x/web-interface/nav'); return { is_login: data?.isLogin === true, wbi_keys_present: Boolean(data?.wbi_img?.img_url && data?.wbi_img?.sub_url) }; });
    await check('history', async () => ({ items: (await client.page('history')).items.length }));
    let folders: any[] = [];
    await check('folders', async () => { folders = await client.folders(); return { items: folders.length }; });
    if (folders.length) await check('favorites', async () => ({ items: (await client.page('favorites', { folders: [String(folders[0].id)], index: 0, page: 1 })).items.length }));
    let bvid: string | undefined;
    await check('wbi_search', async () => { const data = await client.search('游戏设计'); bvid = data.items[0]?.content_id; return { items: data.items.length }; });
    if (bvid) await check('wbi_details', async () => ({ verified: (await client.details(bvid!)).content_id === bvid }));
  }
  const canonical = Object.keys(parts).sort().map(key => `${key}=${parts[key]}`).join('; ');
  return { schema_version: '1.0', checked_at: new Date().toISOString(), group: input.group, credential: { cookie_tag: createHmac('sha256', input.salt).update(canonical).digest('hex'), fields_present: Object.fromEntries(['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'buvid_fp', 'bili_ticket'].map(key => [key, Boolean(parts[key])])) }, checks, requests, upstream_requests: Math.min(count, 8), source_account_modified: false, cache_written: false };
}

export async function claimBilibiliProbe(config: CloudEnv, group: ProbeInput['group'], now = Date.now()) {
  if (!config.DB) throw new AppError('CLOUD_CONFIGURATION_REQUIRED', 503);
  // Atomic across isolates. Repeated calls cannot use a new salt to bypass cooldown.
  const claim = await config.DB.prepare('INSERT INTO pma_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(pma_meta.value AS INTEGER)<=? RETURNING value').bind(`bilibili_diagnostic:${group}`, String(now + 600000), now).first();
  if (!claim) throw new AppError('DIAGNOSTIC_COOLDOWN', 429);
}
