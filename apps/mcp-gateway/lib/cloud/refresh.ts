import {z} from 'zod';
import {MediaService,type CloudEnv} from './service.ts';
import {authorized,AppError} from './security.ts';
import {limitedText} from '../gateway-core.ts';
const steam=['owned_games','recent_games','achievements','related_works'];
const netease=['favorites','recent_plays','user_record_all','user_record_week','playlists','playlist_tracks','listening_stats'];
export const refreshSchema=z.object({schema_version:z.literal('1.0'),device_id:z.string().min(3).max(80),platform:z.enum(['steam','netease']),dataset:z.enum(['owned_games','recent_games','achievements','related_works','favorites','recent_plays','user_record_all','user_record_week','playlists','playlist_tracks','listening_stats']),app_id:z.string().regex(/^[1-9]\d{0,9}$/).optional(),candidate_app_ids:z.array(z.string().regex(/^[1-9]\d{0,9}$/)).min(1).max(3).optional(),restart_cursor:z.boolean().default(false)}).strict().refine(q=>(q.platform==='steam'?steam:netease).includes(q.dataset),'Dataset scope required');
export async function refreshPlatform(request:Request,env:CloudEnv,fetcher:typeof fetch=fetch){
 if(request.method!=='POST')throw new AppError('METHOD_NOT_ALLOWED',405);
 if(!authorized(request.headers.get('authorization')??undefined,env.PMA_REFRESH_TOKEN))throw new AppError('UNAUTHORIZED',401);
 const q=refreshSchema.parse(JSON.parse(await limitedText(request,2048)));if(q.device_id!==env.PMA_INGEST_DEVICE_ID)throw new AppError('DEVICE_SCOPE_DENIED',403);
 const {schema_version,device_id,...input}=q;const result=await new MediaService(env,fetcher).sync(input);
 return {accepted:true,platform:q.platform,dataset:q.dataset,status:result.status,records_committed:result.records_committed,has_more:result.has_more,...('summary'in result?{summary:result.summary}:{})};
}
