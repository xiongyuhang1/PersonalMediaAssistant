import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { MediaService, type CloudEnv } from '@/lib/cloud/service';
import { exportResponse } from '@/lib/cloud/export';
import { AppError } from '@/lib/cloud/security';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    const search = Object.fromEntries(new URL(request.url).searchParams);
    return await exportResponse(new MediaService(env as CloudEnv).store, user.userId, search);
  } catch (error) { return Response.json({ code: error instanceof AppError ? error.code : 'INVALID_EXPORT_REQUEST' }, { status: error instanceof AppError ? error.http : 400 }); }
}
