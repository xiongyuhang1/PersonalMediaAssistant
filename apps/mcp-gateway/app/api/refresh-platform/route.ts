import {env} from 'cloudflare:workers';
import {refreshPlatform} from '@/lib/cloud/refresh';
import {AppError} from '@/lib/cloud/security';
import type {CloudEnv} from '@/lib/cloud/service';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{return Response.json(await refreshPlatform(request,env as CloudEnv),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({code:e instanceof AppError?e.code:'INVALID_REFRESH_REQUEST'},{status:e instanceof AppError?e.http:400,headers:{'Cache-Control':'no-store'}});}}
