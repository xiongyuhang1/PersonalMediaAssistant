import { z } from 'zod';
import type { CloudStore } from './store.ts';
import { recordSchema } from './contracts.ts';
import { AppError, hash } from './security.ts';
import { subtitleJobSchema } from './bilibili-extra.ts';
import { bilibiliSubtitles } from './subtitles.ts';
export const biliDatasets = ['history','favorite_folders','favorites','likes','coins','watch_later','followings','subtitles'] as const;
const common = { schema_version:z.literal('1.0'),device_id:z.string().regex(/^[A-Za-z0-9_-]{3,80}$/) };
const uuid = z.uuid(); const epoch = z.union([z.literal('initial'),uuid]);
const pageSchema = z.object({...common,op:z.literal('page'),page_id:uuid,dataset:z.enum(biliDatasets),epoch,generation:uuid,previous:uuid.nullable(),items:z.array(recordSchema).max(180),next_cursor:z.unknown(),snapshot:z.boolean(),request_id:uuid.optional()}).strict().superRefine((q,ctx)=>{
 if(q.items.some(r=>r.platform!=='bilibili'||r.dataset!==q.dataset))ctx.addIssue({code:'custom',message:'Bilibili dataset scope required'});
 if(q.snapshot !== !['history','subtitles'].includes(q.dataset))ctx.addIssue({code:'custom',message:'Snapshot semantics mismatch'});
 if((q.dataset==='subtitles')!==Boolean(q.request_id))ctx.addIssue({code:'custom',message:'Subtitle request scope required'});
 if(JSON.stringify(q.next_cursor??null).length>10000)ctx.addIssue({code:'custom',message:'Cursor too large'});
 if(q.items.some(r=>(q.dataset==='likes'||q.dataset==='coins')&&(r.record_kind!=='interaction_state'||r.interaction!==(q.dataset==='likes'?'like':'coin'))))ctx.addIssue({code:'custom',message:'Interaction semantics required'});
});
export const collectorSchema = z.discriminatedUnion('op',[
 z.object({...common,op:z.literal('state')}).strict(),pageSchema,
 z.object({...common,op:z.literal('request_subtitles'),epoch,bvid:z.string().regex(/^BV[A-Za-z0-9]{10}$/),cid:z.string().regex(/^\d{1,20}$/).optional(),language:z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional()}).strict(),
 z.object({...common,op:z.literal('fail'),dataset:z.enum(biliDatasets),code:z.enum(['AUTH_EXPIRED','RISK_CONTROLLED','RATE_LIMITED','UPSTREAM_CHANGED','UPSTREAM_UNAVAILABLE','PERMISSION_DENIED'])}).strict(),
]);
const prefix='bili_collector:';
const note=(dataset:string)=>dataset==='history'?'本机读取并上传的平台当前可见历史窗口；按BV/分P保留最后观看观察，不是全部历史或每次观看。':dataset==='likes'?'本机读取并上传的最近点赞窗口；未提供点赞时间，发布时间不作点赞时间。':dataset==='coins'?'本机读取并上传的最近投币窗口；time为投币时间，coins为本人本条数量，不是全站投币数。':dataset==='watch_later'?'本机读取并上传的稍后再看当前集合，不等于已观看或明确喜欢。':dataset==='followings'?'本机读取并上传的平台可见关注UP主列表，不推断关注日期或全部历史。':dataset==='subtitles'?'本机按指定BV/分P/语言读取的字幕，时间为视频内秒数；默认只读第一P，不是观看事件。':'本机读取并上传的收藏快照，完整分页接收后清理上一快照；收藏不等同明确喜欢。';
export async function receiveBilibili(store:CloudStore,deviceId:string|undefined,input:unknown){
 const q=collectorSchema.parse(input);if(q.device_id!==deviceId)throw new AppError('DEVICE_SCOPE_DENIED',403);
 if(q.op==='state'){
  const control=await store.control('bilibili');const datasets=[];
  for(const dataset of biliDatasets){const state=await store.state('bilibili',dataset);const seq=await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind(prefix+'sequence:'+dataset).first<{value:string}>();datasets.push({dataset,previous:seq?.value??null,state:state?.state??'not_synced',cursor:state?.cursor?JSON.parse(state.cursor):null,generation:state?.generation??null,last_success:state?.last_success??null});}
  const jobs=await store.db.prepare("SELECT value FROM pma_meta WHERE key LIKE 'bili_collector:subtitle_job:%' ORDER BY key LIMIT 20").all<{value:string}>();
  const pending=datasets.find(d=>d.dataset==='subtitles')?.cursor?.request_id;
  return {accepted:true,...control,datasets,subtitle_jobs:jobs.results.map(r=>subtitleJobSchema.parse(JSON.parse(r.value))).sort((a,b)=>Number(b.request_id===pending)-Number(a.request_id===pending)).slice(0,5)};
 }
 await store.assertSyncAllowed('bilibili');
 if(q.op==='fail'){await store.fail('bilibili',q.dataset,q.code);return {accepted:true};}
 if((await store.control('bilibili')).sync_epoch!==q.epoch)throw new AppError('COLLECTOR_EPOCH_CHANGED',409);
 if(q.op==='request_subtitles'){const r=await bilibiliSubtitles(store,{bvid:q.bvid,cid:q.cid,language:q.language,limit:1});return {accepted:true,status:r.status,queued:r.status==='queued_for_local_reader'};}
 const digest=hash(JSON.stringify(q)),receiptKey=prefix+'receipt:'+q.page_id;
 const read=()=>store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind(receiptKey).first<{value:string}>();
 const duplicate=(row:{value:string})=>{if(JSON.parse(row.value).digest!==digest)throw new AppError('PAGE_ID_CONFLICT',409);return {accepted:true,duplicate:true,page_id:q.page_id,records:q.items.length};};
 const old=await read();if(old)return duplicate(old);
 let jobKey:string|undefined;
 if(q.dataset==='subtitles'){
  const rows=await store.db.prepare("SELECT key,value FROM pma_meta WHERE key LIKE 'bili_collector:subtitle_job:%'").all<{key:string;value:string}>();const found=rows.results.find(r=>JSON.parse(r.value).request_id===q.request_id);if(!found)throw new AppError('SUBTITLE_REQUEST_EXPIRED',409);const job=subtitleJobSchema.parse(JSON.parse(found.value));jobKey=found.key;
  if(q.generation!==job.request_id||q.items.some(r=>r.content_id!==job.bvid||r.subtitle_request_key!==job.key||r.record_kind!=='metadata_snapshot'||!r.subtitle_status||job.cid&&r.parent_id!==job.cid||job.language&&r.subtitle_status==='available'&&r.subtitle_language!==job.language))throw new AppError('SUBTITLE_REQUEST_SCOPE_DENIED',403);
  if(q.next_cursor!==null&&(typeof q.next_cursor!=='object'||(q.next_cursor as any)?.request_id!==job.request_id||!Number.isSafeInteger((q.next_cursor as any)?.offset)||(q.next_cursor as any).offset<0))throw new AppError('INVALID_CURSOR');
 }
 const seqKey=prefix+'sequence:'+q.dataset;const seq=await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind(seqKey).first<{value:string}>();
 if((seq?.value??null)!==q.previous)throw new AppError('COLLECTOR_SEQUENCE_CHANGED',409);
 const state=await store.state('bilibili',q.dataset);
 if(state?.cursor&&state.generation!==q.generation)throw new AppError('COLLECTOR_GENERATION_CHANGED',409);
 const active=`NOT EXISTS(SELECT 1 FROM platform_controls WHERE platform='bilibili' AND sync_paused<>0) AND COALESCE((SELECT sync_epoch FROM platform_controls WHERE platform='bilibili'),'initial')='${q.epoch}'`;
 const statements=[
  store.db.prepare(`INSERT INTO pma_meta SELECT ?,? WHERE ${active}`).bind(prefix+'slot:'+q.epoch+':'+q.dataset+':'+(q.previous??'initial'),q.page_id),
  store.db.prepare(`INSERT INTO pma_meta SELECT ?,? WHERE ${active}`).bind(receiptKey,JSON.stringify({digest,dataset:q.dataset,received_at:new Date().toISOString()})),
  store.db.prepare(`INSERT INTO pma_meta SELECT ?,? WHERE ${active} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(seqKey,q.page_id),
 ];
 if(jobKey&&q.next_cursor===null){const job=subtitleJobSchema.parse(JSON.parse((await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind(jobKey).first<{value:string}>())!.value));statements.push(store.db.prepare(`DELETE FROM media_records WHERE platform='bilibili' AND dataset='subtitles' AND json_extract(payload,'$.subtitle_request_key')=? AND generation<>? AND ${active}`).bind(job.key,q.generation),store.db.prepare(`DELETE FROM pma_meta WHERE key=? AND ${active}`).bind(jobKey));}
 try{await store.page('bilibili',q.dataset,q.items,q.next_cursor,q.generation,q.snapshot,note(q.dataset),{epoch:q.epoch,statements});}
 catch(error){const concurrent=await read();if(concurrent)return duplicate(concurrent);const current=await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind(seqKey).first<{value:string}>();if((current?.value??null)!==q.previous)throw new AppError('COLLECTOR_SEQUENCE_CHANGED',409);throw error;}
 return {accepted:true,duplicate:false,page_id:q.page_id,records:q.items.length,has_more:q.next_cursor!=null};
}
