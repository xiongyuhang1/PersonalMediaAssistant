import { env } from 'cloudflare:workers';
import { limitedText } from '@/lib/gateway-core';
import { MediaService, type CloudEnv } from '@/lib/cloud/service';
import { authorized, AppError } from '@/lib/cloud/security';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const config = env as CloudEnv;
  if (!authorized(request.headers.get('authorization') ?? undefined, config.PMA_INGEST_TOKEN)) return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const data = JSON.parse(await limitedText(request, 131072));
    const service = new MediaService(config);
    return Response.json(data?.heartbeat === true ? await service.heartbeat(data) : await service.ingest(data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { const code = error instanceof AppError ? error.code : 'INVALID_BATCH'; return Response.json({ status: 'unavailable', code }, { status: error instanceof AppError ? error.http : 400 }); }
}
