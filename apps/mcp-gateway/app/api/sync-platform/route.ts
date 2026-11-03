import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { type CloudEnv } from '@/lib/cloud/service';
import { syncFromWeb } from '@/lib/cloud/web-sync';
import { AppError } from '@/lib/cloud/security';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    const result = await syncFromWeb(request, user?.userId ?? null, env as CloudEnv);
    const target = new URL('/', request.url); target.searchParams.set('sync_platform', result.platform); target.hash = 'platforms';
    return Response.redirect(target.toString(), 303);
  } catch (error) { return Response.json({ status: 'unavailable', code: error instanceof AppError ? error.code : 'INVALID_ARGUMENTS' }, { status: error instanceof AppError ? error.http : 400, headers: { 'Cache-Control': 'no-store' } }); }
}
