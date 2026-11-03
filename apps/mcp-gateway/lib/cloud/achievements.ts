import { z } from 'zod';
import { safeFetch,type SteamAdapter } from './adapters.ts';
import { recordSchema } from './contracts.ts';
import type { CloudStore } from './store.ts';
import { AppError,hash,readCursor,signCursor } from './security.ts';
export const achievementInput=z.object({app_id:z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>Number(v)<=4294967295),refresh:z.boolean().default(false),unlocked:z.boolean().optional(),limit:z.number().int().min(1).max(50).default(20),cursor:z.string().max(1800).optional()}).strict().refine(q=>!q.refresh||!q.cursor,'Refresh and cursor cannot be combined');
export function mapAchievements(appId:string,title:string,schema:any,player:any){
 const definitions=schema?.game?.availableGameStats?.achievements;
 if(!schema?.game||typeof schema.game.gameName!=='string'||definitions!==undefined&&!Array.isArray(definitions))throw new AppError('UPSTREAM_CHANGED',502);
 const defs=definitions??[];if(defs.length>2000)throw new AppError('UPSTREAM_TOO_LARGE',502);
 const total=defs.length;const stats=player?.playerstats;
 if(total&&(!stats||stats.success!==true||stats.gameID!==undefined&&String(stats.gameID)!==appId))throw new AppError('PERMISSION_OR_DATA_UNAVAILABLE',502);
 if(total&&!Array.isArray(stats.achievements))throw new AppError('UPSTREAM_CHANGED',502);
 const states=new Map<string,any>();for(const s of stats?.achievements??[]){if(typeof s.apiname!=='string'||states.has(s.apiname)||![0,1].includes(s.achieved)||!Number.isSafeInteger(s.unlocktime)||s.unlocktime<0)throw new AppError('UPSTREAM_CHANGED',502);states.set(s.apiname,s);}
 const names=new Set();const achievements=defs.map((d:any)=>{
  if(typeof d.name!=='string'||names.has(d.name)||typeof d.displayName!=='string'||![0,1].includes(d.hidden))throw new AppError('UPSTREAM_CHANGED',502);names.add(d.name);const s=states.get(d.name);if(!s)throw new AppError('ACHIEVEMENT_SCHEMA_MISMATCH',502);
  const at=s.achieved===1&&s.unlocktime>0?new Date(s.unlocktime*1000).toISOString():null;
  if(at&&(Date.parse(at)<Date.UTC(2000,0,1)||Date.parse(at)>Date.now()+86400000))throw new AppError('UPSTREAM_CHANGED',502);
  return {api_name:d.name,name:d.hidden===1&&s.achieved===0?'隐藏成就':d.displayName,hidden:d.hidden===1,unlocked:s.achieved===1,unlocked_at:at,...(d.hidden!==1||s.achieved===1?{description:typeof d.description==='string'?d.description.slice(0,1200):undefined}:{})};
 });if(total&&states.size!==total)throw new AppError('ACHIEVEMENT_SCHEMA_MISMATCH',502);
 const unlocked=achievements.filter((v:any)=>v.unlocked).length;
 return recordSchema.parse({platform:'steam',dataset:'achievements',id:appId,content_id:appId,title,record_kind:'metadata_snapshot',collected_at:new Date().toISOString(),achievement_summary:{total,unlocked,completion_percent:total?Math.round(unlocked/total*10000)/100:null,all_unlocked:total?unlocked===total:null,state:total?'available':'not_applicable'},achievements,url:`https://store.steampowered.com/app/${appId}/`});
}
export async function steamAchievements(store:CloudStore,adapter:SteamAdapter,args:unknown,transport:typeof fetch=fetch){
 const q=achievementInput.parse(args);const owned=await store.db.prepare("SELECT title FROM media_records WHERE platform='steam' AND dataset='owned_games' AND content_id=?").bind(q.app_id).first<{title:string}>();if(!owned)throw new AppError('WORK_NOT_IN_SYNCED_CACHE',404);
 let row=await store.db.prepare("SELECT payload FROM media_records WHERE platform='steam' AND dataset='achievements' AND id=?").bind(q.app_id).first<{payload:string}>();let refreshed=false;
 if(q.refresh){await store.assertSyncAllowed('steam');if(!adapter.configured)throw new AppError('AUTH_REQUIRED',409);const control=await store.control('steam');
  const old=row?recordSchema.parse(JSON.parse(row.payload)):null;
  if(!old||Date.now()-Date.parse(old.collected_at)>300000){
   const bounded=safeFetch(transport);const deadline=Date.now()+18000;
   const request=async(path:string)=>{const url=new URL('https://api.steampowered.com/ISteamUserStats/'+path);url.search=new URLSearchParams({appid:q.app_id,l:'schinese',...(path.startsWith('GetPlayer')?{steamid:adapter.settings.steamId!}:{})}).toString();const response=await bounded(url,{headers:{'x-webapi-key':adapter.settings.steamKey!},signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});const text=await response.text();if(text.length>2000000)throw new AppError('UPSTREAM_TOO_LARGE',502);return JSON.parse(text);};
   const schema=await request('GetSchemaForGame/v2/');const defs=schema?.game?.availableGameStats?.achievements;const player=Array.isArray(defs)&&defs.length?await request('GetPlayerAchievements/v1/'):undefined;
   if(player?.playerstats?.steamID!==undefined&&player.playerstats.steamID!==adapter.settings.steamId)throw new AppError('UPSTREAM_CHANGED',502);
   const item=mapAchievements(q.app_id,owned.title,schema,player);await store.page('steam','achievements',[item],null,crypto.randomUUID(),false,'按游戏读取的官方成就快照；全成就不等同剧情通关。',{epoch:control.sync_epoch,statements:[]});row={payload:JSON.stringify(item)};refreshed=true;
  }
 }
 if(!row)throw new AppError('ACHIEVEMENT_REFRESH_REQUIRED',409);const record=recordSchema.parse(JSON.parse(row.payload));const fingerprint=hash(JSON.stringify({app:q.app_id,unlocked:q.unlocked??null,version:hash(row.payload)}));let offset=0;
 if(q.cursor){const c=readCursor(q.cursor,store.secret);if(c.kind!=='achievements'||c.filters!==fingerprint||!Number.isSafeInteger(c.offset)||Number(c.offset)<0)throw new AppError('INVALID_CURSOR');offset=Number(c.offset);}
 const all=(record.achievements??[]).filter(v=>q.unlocked===undefined||v.unlocked===q.unlocked);const items=all.slice(offset,offset+q.limit);while(JSON.stringify(items).length>10500)items.pop();const next=offset+items.length;
 return {status:'ok',app_id:q.app_id,title:record.title,collected_at:record.collected_at,refreshed,summary:record.achievement_summary,items,has_more:next<all.length,next_cursor:next<all.length?signCursor({kind:'achievements',filters:fingerprint,offset:next},store.secret):null,warnings:['成就完成比例不等于剧情通关或游戏完成；未解锁隐藏成就不主动显示详情。','按App缓存；refresh=true最多每5分钟读取一次，翻页读取同一快照。']};
}
