import {z} from 'zod';
import type {CloudStore} from './store.ts';
import {recordSchema} from './contracts.ts';
import {AppError,hash,readCursor,signCursor} from './security.ts';
export async function bilibiliSubtitles(store:CloudStore,args:unknown){
 const q=z.object({bvid:z.string().regex(/^BV[A-Za-z0-9]{10}$/),cid:z.string().regex(/^\d{1,20}$/).optional(),language:z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional(),request_if_missing:z.boolean().default(true),limit:z.number().int().min(1).max(50).default(20),cursor:z.string().max(1800).optional()}).strict().parse(args);
 const key=`${q.bvid}:${q.cid??'first'}:${q.language??'auto'}`;
 const rows=await store.db.prepare("SELECT payload,generation FROM media_records WHERE platform='bilibili' AND dataset='subtitles' AND content_id=? AND json_extract(payload,'$.subtitle_request_key')=? ORDER BY CAST(json_extract(payload,'$.subtitle_chunk') AS INTEGER)").bind(q.bvid,key).all<{payload:string;generation:string}>();
 if(!rows.results.length){if(q.cursor)throw new AppError('INVALID_CURSOR');await store.assertSyncAllowed('bilibili');if(!q.request_if_missing)return {status:'not_cached',items:[]};const queued=await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('bili_collector:subtitle_job:'+key).first<{value:string}>();if(queued)return {status:'queued_for_local_reader',bvid:q.bvid,requested_part:q.cid??'first_part_only',items:[],duplicate:true};
  const old=await store.db.prepare("SELECT COUNT(*) AS n FROM pma_meta WHERE key LIKE 'bili_collector:subtitle_job:%'").first<{n:number}>();if((old?.n??0)>=20)throw new AppError('LOCAL_REQUEST_QUEUE_FULL',409);
  const job={request_id:crypto.randomUUID(),key,bvid:q.bvid,cid:q.cid,language:q.language,requested_at:new Date().toISOString()};const epoch=(await store.control('bilibili')).sync_epoch;
  await store.db.prepare("INSERT OR IGNORE INTO pma_meta SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM platform_controls WHERE platform='bilibili' AND sync_paused<>0) AND COALESCE((SELECT sync_epoch FROM platform_controls WHERE platform='bilibili'),'initial')=?").bind('bili_collector:subtitle_job:'+key,JSON.stringify(job),epoch).run();
  const after=await store.control('bilibili');if(after.sync_paused)throw new AppError('SYNC_PAUSED_BY_OWNER',409);if(after.sync_epoch!==epoch)throw new AppError('COLLECTOR_EPOCH_CHANGED',409);
  return {status:'queued_for_local_reader',bvid:q.bvid,requested_part:q.cid??'first_part_only',items:[],warnings:['等待本机下次同步时读取；电脑离线时不会即时取得新字幕。默认只读第一P，不合并其他分P。']};
 }
 const pending=await store.db.prepare('SELECT value FROM pma_meta WHERE key=?').bind('bili_collector:subtitle_job:'+key).first<{value:string}>();
 const records=rows.results.map(r=>recordSchema.parse(JSON.parse(r.payload)));const version=hash(rows.results.map(r=>r.payload).join(''));const fingerprint=hash(JSON.stringify({key,version}));let offset=0;if(q.cursor){const c=readCursor(q.cursor,store.secret);if(c.kind!=='subtitles'||c.filters!==fingerprint||!Number.isSafeInteger(c.offset)||Number(c.offset)<0)throw new AppError('INVALID_CURSOR');offset=Number(c.offset);}
 const all=records.flatMap(r=>r.transcript??[]);const items=all.slice(offset,offset+q.limit);while(JSON.stringify(items).length>10500)items.pop();const next=offset+items.length;const first=records[0];
 return {status:pending?'partial':'ok',collection_complete:!pending,available_segments:all.length,availability:first.subtitle_status,bvid:q.bvid,cid:first.parent_id,title:first.title,language:first.subtitle_language,collected_at:first.collected_at,items,has_more:next<all.length,next_cursor:next<all.length?signCursor({kind:'subtitles',filters:fingerprint,offset:next},store.secret):null,warnings:[...(pending?['字幕仍在本机读取/上传，当前仅为已接收的部分；末页不代表完整字幕。']:[]),'字幕由本机按需读取；不是所有视频都有可用字幕，自动字幕可能有误。时间单位为视频内秒数，不是观看日期。']};
}
