import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import type { CloudEnv } from '@/lib/cloud/service';
import { manageDataFromWeb } from '@/lib/cloud/web-data';
import { AppError } from '@/lib/cloud/security';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const target = new URL('/data', request.url);
  try {
    const user = await getChatGPTUser(); const result = await manageDataFromWeb(request, user?.userId ?? null, env as CloudEnv);
    target.searchParams.set('result', result.action === 'delete' ? 'deleted' : 'resumed');
  } catch (error) { target.searchParams.set('error', error instanceof AppError ? error.code : 'INVALID_ARGUMENTS'); }
  return new Response(null, { status: 303, headers: { Location: target.toString(), 'Cache-Control': 'private, no-store' } });
}
