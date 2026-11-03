import { z } from 'zod';
import type { BilibiliAdapter } from './adapters.ts';
import { recordSchema,type Dataset,type Page } from './contracts.ts';
import { AppError,hash } from './security.ts';
const arr=(v:any):any[]=>{if(!Array.isArray(v))throw new AppError('UPSTREAM_CHANGED',502);return v;};
export async function biliExtraPage(a:BilibiliAdapter,dataset:Dataset,cursor?:unknown):Promise<Page>{
 if(dataset==='watch_later'){
  const c=cursor as any??{offset:0};if(!Number.isSafeInteger(c.offset)||c.offset<0)throw new AppError('INVALID_CURSOR');const d=await a.json('/x/v2/history/toview');const list=d.list==null&&d.count===0?[]:arr(d.list);const digest=hash(JSON.stringify(list.map(v=>[v.bvid,v.add_at])));if(c.digest&&c.digest!==digest)throw new AppError('SNAPSHOT_CHANGED_RESTART_REQUIRED',409);
  const page=list.slice(c.offset,c.offset+100);return {snapshot:true,items:page.filter(v=>/^BV[A-Za-z0-9]{10}$/.test(v.bvid)).map(v=>recordSchema.parse({...a.video({...v,upper:v.owner},dataset),source_time:undefined,source_time_semantics:'unknown'})),next_cursor:c.offset+page.length<list.length?{offset:c.offset+page.length,digest}:undefined,coverage_note:'本机读取的稍后再看当前集合；不视为已看或明确喜欢，add_at未混作观看时间。'};
 }
 if(dataset==='followings'){
  const c=cursor as any??{page:1};if(!Number.isSafeInteger(c.page)||c.page<1||c.page>200)throw new AppError('INVALID_CURSOR');const me=await a.json('/x/web-interface/nav');if(!me.isLogin)throw new AppError('AUTH_EXPIRED',502);const d=await a.json('/x/relation/followings',{vmid:me.mid,pn:c.page,ps:50,order:'desc'});const list=arr(d.list);if(!Number.isSafeInteger(d.total)||d.total<0||!list.length&&(c.page-1)*50<d.total)throw new AppError('UPSTREAM_INCOMPLETE',502);
  return {snapshot:true,items:list.map(v=>recordSchema.parse({platform:'bilibili',dataset,id:String(v.mid),content_id:String(v.mid),title:String(v.uname).slice(0,600),uploader_id:String(v.mid),uploader_name:String(v.uname).slice(0,160),record_kind:'collection_state',collected_at:new Date().toISOString(),url:`https://space.bilibili.com/${v.mid}`})),next_cursor:c.page*50<d.total?{page:c.page+1}:undefined,coverage_note:'本机读取账号当前可见的关注UP列表；mtime/follow_time语义未核实时不当作关注日期，平台可见范围不保证全部。'};
 }
 throw new AppError('UNSUPPORTED');
}
export const subtitleJobSchema=z.object({request_id:z.uuid(),key:z.string().max(160),bvid:z.string().regex(/^BV[A-Za-z0-9]{10}$/),cid:z.string().regex(/^\d{1,20}$/).optional(),language:z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional(),requested_at:z.iso.datetime()}).strict();
export type SubtitleJob=z.infer<typeof subtitleJobSchema>;
export async function readLocalSubtitles(a:BilibiliAdapter,job:SubtitleJob,transport:typeof fetch=fetch){
 const j=subtitleJobSchema.parse(job);const v=await a.json('/x/web-interface/view',{bvid:j.bvid});if(v.bvid!==j.bvid)throw new AppError('UPSTREAM_CHANGED',502);const parts=arr(v.pages);const part=j.cid?parts.find(p=>String(p.cid)===j.cid):parts[0];if(!part)throw new AppError('CONTENT_UNAVAILABLE',404);if(!/^\d{1,20}$/.test(String(part.cid)))throw new AppError('UPSTREAM_CHANGED',502);
 const p=await a.json('/x/player/wbi/v2',{bvid:j.bvid,cid:part.cid},true);const tracks=arr(p.subtitle?.subtitles??[]);const track=j.language?tracks.find(t=>t.lan===j.language):tracks.find(t=>t.lan==='zh-CN'||t.lan==='ai-zh')??tracks[0];
 const base={platform:'bilibili',dataset:'subtitles',content_id:j.bvid,parent_id:String(part.cid),title:String(v.title).slice(0,600),record_kind:'metadata_snapshot',collected_at:new Date().toISOString(),subtitle_request_key:j.key,url:`https://www.bilibili.com/video/${j.bvid}?p=${part.page}`};
 if(!track||!track.subtitle_url)return [recordSchema.parse({...base,id:j.key+':0',subtitle_status:'unavailable',subtitle_chunk:0})];
 const u=new URL(track.subtitle_url.startsWith('//')?'https:'+track.subtitle_url:track.subtitle_url);if(u.protocol!=='https:'||u.username||u.password||u.port||!(u.hostname==='hdslb.com'||u.hostname.endsWith('.hdslb.com')))throw new AppError('SUBTITLE_HOST_DENIED',502);
 const response=await transport(u,{redirect:'manual',signal:AbortSignal.timeout(12000)});if(!response.ok||response.status>=300)throw new AppError('UPSTREAM_UNAVAILABLE',502);if(Number(response.headers.get('content-length'))>2000000)throw new AppError('UPSTREAM_TOO_LARGE',502);const text=await response.text();if(text.length>2000000)throw new AppError('UPSTREAM_TOO_LARGE',502);const body=arr(JSON.parse(text).body);if(body.length>10000)throw new AppError('UPSTREAM_TOO_LARGE',502);
 const lines=body.map(l=>{if(typeof l.from!=='number'||typeof l.to!=='number'||l.from<0||l.to<l.from||typeof l.content!=='string'||l.content.length>1200)throw new AppError('UPSTREAM_CHANGED',502);return {start_seconds:l.from,end_seconds:l.to,text:l.content};});const records=[];
 for(let i=0;i<lines.length||i===0;i+=40)records.push(recordSchema.parse({...base,id:j.key+':'+i/40,subtitle_language:track.lan,subtitle_status:lines.length?'available':'unavailable',subtitle_chunk:i/40,transcript:lines.slice(i,i+40)}));return records;
}
