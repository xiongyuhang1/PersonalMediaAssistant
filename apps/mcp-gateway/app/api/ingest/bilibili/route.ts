import { env } from 'cloudflare:workers';
import { limitedText } from '@/lib/gateway-core';
import { MediaService,type CloudEnv } from '@/lib/cloud/service';
import { authorized,AppError } from '@/lib/cloud/security';
import { receiveBilibili } from '@/lib/cloud/bilibili-collector';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const config=env as CloudEnv;
 if(!authorized(request.headers.get('authorization')??undefined,config.PMA_BILI_INGEST_TOKEN))return Response.json({code:'UNAUTHORIZED'},{status:401});
 try{const data=JSON.parse(await limitedText(request,196608));const service=new MediaService(config);return Response.json(await receiveBilibili(service.store,config.PMA_INGEST_DEVICE_ID,data),{headers:{'Cache-Control':'no-store'}});}
 catch(error){return Response.json({code:error instanceof AppError?error.code:'INVALID_BATCH'},{status:error instanceof AppError?error.http:400,headers:{'Cache-Control':'no-store'}});}
}
