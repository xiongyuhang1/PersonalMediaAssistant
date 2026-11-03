import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import type { CloudEnv } from '@/lib/cloud/service';
import { CloudStore } from '@/lib/cloud/store';
import { authorized, AppError } from '@/lib/cloud/security';
import { limitedText } from '@/lib/gateway-core';
import { biliProbeSchema, claimBilibiliProbe, runBilibiliProbe } from '@/lib/cloud/bilibili-diagnostics';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const config = env as CloudEnv; const headers = { 'Cache-Control': 'private, no-store' };
  try {
    // Automated diagnostics use the existing service credential plus the Sites
    // owner-private dispatch gate. Browsers additionally require owner + Origin.
    if (!authorized(request.headers.get('authorization') ?? undefined, config.PMA_INGEST_TOKEN)) {
      const user = await getChatGPTUser(); if (!user) throw new AppError('AUTH_REQUIRED', 401);
      if (request.headers.get('origin') !== new URL(request.url).origin) throw new AppError('ORIGIN_DENIED', 403);
      if (!config.DB || !config.PMA_CURSOR_KEY) throw new AppError('CLOUD_CONFIGURATION_REQUIRED', 503);
      await new CloudStore(config.DB, config.PMA_CURSOR_KEY).owner(user.userId);
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('INVALID_CONTENT_TYPE', 415);
    const input = biliProbeSchema.parse(JSON.parse(await limitedText(request, 1024)));
    if (!config.BILIBILI_COOKIE) throw new AppError('AUTH_REQUIRED', 409);
    await claimBilibiliProbe(config, input.group);
    return Response.json({ runtime: 'sites_cloudflare_worker', ...await runBilibiliProbe(config.BILIBILI_COOKIE, input) }, { headers });
  } catch (error) { return Response.json({ status: 'unavailable', code: error instanceof AppError ? error.code : 'INVALID_ARGUMENTS' }, { status: error instanceof AppError ? error.http : 400, headers }); }
}
