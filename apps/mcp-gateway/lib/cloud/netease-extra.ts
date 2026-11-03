import { z } from 'zod';
import { type Dataset,type Page,recordSchema } from './contracts.ts';
import type { NeteaseAdapter } from './adapters.ts';
import { AppError,hash } from './security.ts';
const obj=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new AppError('UPSTREAM_CHANGED',502);return v;};
const arr=(v:any):any[]=>{if(!Array.isArray(v))throw new AppError('UPSTREAM_CHANGED',502);return v;};
const title=(v:any,max=600)=>{if(typeof v!=='string'||!v.trim())throw new AppError('UPSTREAM_CHANGED',502);return v.trim().slice(0,max);};
const id=(v:any)=>{if(!/^\d{1,20}$/.test(String(v)))throw new AppError('UPSTREAM_CHANGED',502);return String(v);};
const n=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const date=(v:any)=>{const x=n(v);return x&&x>=Date.UTC(2000,0,1)&&x<=Date.now()+86400000?new Date(x).toISOString():undefined;};
export const songMetadata=(s:any)=>({album:typeof s.al?.name==='string'?s.al.name.slice(0,300):undefined,album_id:s.al?.id?id(s.al.id):undefined,artist_ids:Array.isArray(s.ar)?s.ar.filter((a:any)=>a.id>0).slice(0,30).map((a:any)=>id(a.id)):undefined,artists:Array.isArray(s.ar)?s.ar.slice(0,30).map((a:any)=>title(a.name,160)):[],duration_ms:n(s.dt)});
async function playlistList(adapter:NeteaseAdapter,offset=0){const data=await adapter.call('/user/playlist',{uid:adapter.settings.neteaseUid,limit:30,offset,includeVideo:true});if(typeof data.more!=='boolean')throw new AppError('UPSTREAM_CHANGED',502);return {list:arr(data.playlist),more:data.more};}
export async function neteaseExtraPage(adapter:NeteaseAdapter,dataset:Dataset,cursor?:unknown):Promise<Page>{
 if(dataset==='playlists'){
  const offset=cursor===undefined?0:obj(cursor).offset;if(!Number.isSafeInteger(offset)||offset<0||offset>30000)throw new AppError('INVALID_CURSOR');const {list,more}=await playlistList(adapter,offset);if(more&&!list.length)throw new AppError('UPSTREAM_INCOMPLETE',502);
  return {snapshot:true,items:list.map(p=>recordSchema.parse({platform:'netease',dataset,id:id(p.id),content_id:id(p.id),title:title(p.name),record_kind:'collection_state',collected_at:new Date().toISOString(),playlist_owner:String(p.creator?.userId)===adapter.settings.neteaseUid?'created':p.subscribed===true?'subscribed':'unknown',track_count:n(p.trackCount),url:`https://music.163.com/#/playlist?id=${id(p.id)}`})),next_cursor:more?{offset:offset+list.length}:undefined,coverage_note:'当前账号创建与收藏的歌单目录快照；歌曲须独立同步playlist_tracks，不只取详情首屏。'};
 }
 if(dataset==='playlist_tracks'){
  const c=cursor?obj(cursor):{list_offset:0,index:0,offset:0};if(![c.list_offset,c.index,c.offset].every(v=>Number.isSafeInteger(v)&&v>=0)||c.list_offset>30000)throw new AppError('INVALID_CURSOR');
  const {list,more}=await playlistList(adapter,c.list_offset);const listDigest=hash(JSON.stringify(list.map(v=>id(v.id))));if(c.list_digest&&c.list_digest!==listDigest)throw new AppError('SNAPSHOT_CHANGED_RESTART_REQUIRED',409);
  if(c.index>=list.length){if(more)throw new AppError('UPSTREAM_CHANGED',502);return {snapshot:true,items:[]};}
  const p=list[c.index],pid=id(p.id);const detail=obj((await adapter.call('/playlist/detail',{id:pid,n:100000,s:0})).playlist);if(id(detail.id)!==pid)throw new AppError('UPSTREAM_CHANGED',502);const trackIds=arr(detail.trackIds).map(v=>id(v.id));if(n(detail.trackCount)!==trackIds.length)throw new AppError('UPSTREAM_INCOMPLETE',502);const digest=hash(JSON.stringify(trackIds));if(c.digest&&c.digest!==digest)throw new AppError('SNAPSHOT_CHANGED_RESTART_REQUIRED',409);
  const ids=trackIds.slice(c.offset,c.offset+100);const songs=ids.length?arr((await adapter.call('/song/detail',{ids:ids.join(',')})).songs):[];const wanted=new Set(ids);if(songs.some(s=>!wanted.has(id(s.id))))throw new AppError('UPSTREAM_CHANGED',502);if(songs.length!==ids.length||new Set(songs.map(s=>id(s.id))).size!==ids.length)throw new AppError('UPSTREAM_INCOMPLETE',502);
  const next=c.offset+ids.length<trackIds.length?{...c,list_digest:listDigest,digest,offset:c.offset+ids.length}:c.index+1<list.length?{list_offset:c.list_offset,list_digest:listDigest,index:c.index+1,offset:0}:more?{list_offset:c.list_offset+list.length,index:0,offset:0}:undefined;
  return {snapshot:true,items:songs.map(s=>recordSchema.parse({platform:'netease',dataset,id:`${pid}:${id(s.id)}`,content_id:id(s.id),parent_id:pid,title:title(s.name),record_kind:'collection_state',collected_at:new Date().toISOString(),...songMetadata(s),url:`https://music.163.com/#/song?id=${id(s.id)}`})),next_cursor:next,coverage_note:'逐歌单按trackIds读取曲目；详情受版权/权限影响不可用歌曲不补造，收藏歌单曲目不等于每首都喜欢或播放过。'};
 }
 if(dataset==='listening_stats'){
  const index=cursor===undefined?0:obj(cursor).index;if(!Number.isInteger(index)||index<0||index>3)throw new AppError('INVALID_CURSOR');const period=(['week','month','total','annual']as const)[index];
  const route=index<2?'/listen/data/realtime/report':index===2?'/listen/data/total':'/listen/data/year/report';const d=obj((await adapter.call(route,index<2?{type:period}:{})).data);let entries:any[];
  if(index<2){if(d.type!==period)throw new AppError('UPSTREAM_CHANGED',502);const b=obj(d.listenTimeDistributionBlock);if(n(b.playDuration)===undefined)throw new AppError('UPSTREAM_CHANGED',502);entries=[{id:period,title:period==='week'?'网易云本周收听统计':'网易云本月收听统计',value:{period,start_at:date(d.startTime),end_at:date(d.endTime),duration_raw:b.playDuration,duration_unit:'minutes',listen_days:n(b.listenDays),days:arr(b.durationDetails).map(v=>({day:v.period,duration_raw:v.duration,podcast_duration_raw:n(v.podcastDuration),audiobook_duration_raw:n(v.audiobookDuration),limit_reached:typeof v.reachLimit==='boolean'?v.reachLimit:undefined}))}}];}
  else if(index===2){if(n(d.totalDuration)===undefined)throw new AppError('UPSTREAM_CHANGED',502);entries=[{id:'total',title:'网易云总收听统计',value:{period,duration_raw:d.totalDuration,duration_unit:'seconds'}}];}
  else entries=arr(d.yearItems).map(v=>({id:`annual:${v.year}`,title:`网易云${v.year}年度足迹`,value:{period,year:v.year,play_num_raw:n(v.playNum),duration_raw:n(v.playDuration),duration_unit:'seconds'}}));
  return {snapshot:true,items:entries.map(v=>recordSchema.parse({platform:'netease',dataset,id:v.id,content_id:v.id,title:v.title,record_kind:'metadata_snapshot',collected_at:new Date().toISOString(),listening_statistic:{...v.value,unit_basis:'inferred_user_accepted',duration_minutes:v.value.duration_raw===undefined?undefined:Math.round(v.value.duration_raw/(v.value.duration_unit==='seconds'?60:1)*100)/100,duration_hours:v.value.duration_raw===undefined?undefined:Math.round(v.value.duration_raw/(v.value.duration_unit==='seconds'?3600:60)*100)/100}})),next_cursor:index<3?{index:index+1}:undefined,coverage_note:'平台周/月duration按分钟、总量/年度duration按秒换算，依据实际数值与用户接受的推定口径（inferred_user_accepted），保留原始值供修正；不是官方已证实单位。年度足迹不是完整年度报告。'};
 }
 throw new AppError('UNSUPPORTED');
}
export async function neteaseLyrics(adapter:NeteaseAdapter,args:unknown){
 const q=z.object({song_id:z.string().regex(/^\d{1,20}$/),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(10).default(3),translation:z.boolean().default(false)}).strict().parse(args);
 const d=await adapter.call('/lyric',{id:q.song_id,tv:-1,lv:-1,rv:-1,kv:-1,_nmclfl:1});const raw=q.translation?d.tlyric?.lyric:d.lrc?.lyric;if(raw!==undefined&&typeof raw!=='string')throw new AppError('UPSTREAM_CHANGED',502);
 const lines=typeof raw==='string'?raw.split(/\r?\n/).filter(Boolean):[];const selected=lines.slice(q.offset,q.offset+q.limit).map(v=>v.slice(0,600));
 return {status:'ok',song_id:q.song_id,availability:d.nolyric===true?'instrumental':lines.length?'available':'unavailable',translation:q.translation,lines:selected,has_more:q.offset+selected.length<lines.length,next_offset:q.offset+selected.length<lines.length?q.offset+selected.length:null,warnings:['按需读取歌词片段；不下载音频，不作为播放或喜好证据。']};
}
