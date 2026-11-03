import { readFile,writeFile,mkdir,rename,unlink,open } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BilibiliAdapter } from '../../apps/mcp-gateway/lib/cloud/adapters.ts';
import { recordSchema } from '../../apps/mcp-gateway/lib/cloud/contracts.ts';
import { readLocalSubtitles } from '../../apps/mcp-gateway/lib/cloud/bilibili-extra.ts';
import { AppError } from '../../apps/mcp-gateway/lib/cloud/security.ts';
const datasets=['watch_later','followings','likes','coins','favorite_folders','favorites','history'] as const;
const arg=(key:string,fallback:string)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:fallback;
const stateRoot=resolve(arg('--state','.local/bilibili'));const maxPages=Number(arg('--max-pages','180'));
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const exists=async(path:string)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('LOCAL_STATE_INVALID');}};
async function atomic(path:string,data:unknown){await writeFile(path+'.tmp',JSON.stringify(data),{mode:0o600});await rename(path+'.tmp',path);}
async function main(){
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>1000)throw new Error('INVALID_PAGE_BUDGET');
 await mkdir(stateRoot,{recursive:true});const lockPath=resolve(stateRoot,'collector.lock');let lock;
 try{lock=await open(lockPath,'wx');}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=await exists(lockPath);let running=true;try{process.kill(old.pid,0);}catch(err){running=(err as NodeJS.ErrnoException).code!=='ESRCH';}if(running)throw new Error('COLLECTOR_ALREADY_RUNNING');await unlink(lockPath);lock=await open(lockPath,'wx');}
 await lock.writeFile(JSON.stringify({pid:process.pid}));
 try{
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>30000)throw new Error('INVALID_CREDENTIALS');}
  const c=JSON.parse(raw);raw='';
  if(c.endpoint!=='https://your-site.example.invalid/api/ingest/bilibili'||!c.ingest_token||!c.sites_token||!c.BILIBILI_COOKIE||!c.device_id)throw new Error('INVALID_CREDENTIALS');
  const base={schema_version:'1.0',device_id:c.device_id};
  async function request(data:unknown){const response=await fetch(c.endpoint,{method:'POST',headers:{'Authorization':'Bearer '+c.ingest_token,'OAI-Sites-Authorization':'Bearer '+c.sites_token,'Content-Type':'application/json'},body:JSON.stringify({...base,...data as object}),redirect:'manual',signal:AbortSignal.timeout(30000)});if(!response.ok){let code='UPLOAD_HTTP_'+response.status;try{const body=await response.json() as any;if(typeof body.code==='string'&&/^[A-Z_]{3,80}$/.test(body.code))code=body.code;}catch{}throw new Error(code);}const body=await response.json() as any;if(body.accepted!==true)throw new Error('UPLOAD_NOT_ACKNOWLEDGED');return body;}
  let cloud=await request({op:'state'});if(cloud.sync_paused){console.log(JSON.stringify({status:'paused_by_owner',source_read:false}));return;}
  const pendingPath=resolve(stateRoot,'pending.json');let pending=await exists(pendingPath);
  if(pending){const remote=cloud.datasets.find((v:any)=>v.dataset===pending.dataset);if(pending.epoch===cloud.sync_epoch&&(remote.previous===pending.previous||remote.previous===pending.page_id)){await request(pending);console.log(JSON.stringify({status:'pending_page_acknowledged',dataset:pending.dataset,records:pending.items.length}));}await unlink(pendingPath);cloud=await request({op:'state'});}
  const adapter=new BilibiliAdapter({biliCookie:c.BILIBILI_COOKIE});
  const subtitleResults:Array<{status:string;chunks?:number;segments?:number;code?:string}>=[];
  for(const job of cloud.subtitle_jobs??[]){
   const state=cloud.datasets.find((v:any)=>v.dataset==='subtitles');if(state.cursor&&state.cursor.request_id!==job.request_id)continue;
   try{const records=await readLocalSubtitles(adapter,job);let offset=state.cursor?.offset??0,previous=state.previous;while(offset<records.length){const items=records.slice(offset,offset+2);while(items.length>1&&Buffer.byteLength(JSON.stringify(items),'utf8')>150000)items.pop();const next=offset+items.length<records.length?{request_id:job.request_id,offset:offset+items.length}:null;pending={op:'page',page_id:randomUUID(),dataset:'subtitles',epoch:cloud.sync_epoch,generation:job.request_id,previous,items,next_cursor:next,snapshot:false,request_id:job.request_id};await atomic(pendingPath,pending);const ack=await request(pending);if(ack.page_id!==pending.page_id)throw new Error('PAGE_ACK_MISMATCH');await unlink(pendingPath);pending=null;previous=ack.page_id;offset+=items.length;}const result={status:'synced',chunks:records.length,segments:records.reduce((n,r)=>n+(r.transcript?.length??0),0)};subtitleResults.push(result);console.log(JSON.stringify({event:'subtitle_uploaded',...result}));cloud=await request({op:'state'});}catch(e){if(pending)throw e;const result={status:'failed',code:e instanceof AppError?e.code:'LOCAL_SUBTITLE_FAILED'};subtitleResults.push(result);console.log(JSON.stringify({event:'subtitle_failed',...result}));}
  }
  const checkpointPath=resolve(stateRoot,'watermarks.json');let checkpoints=await exists(checkpointPath)??{};if(checkpoints.epoch!==cloud.sync_epoch)checkpoints={epoch:cloud.sync_epoch};
  let pages=0;const results=[];
  for(const dataset of process.argv.includes('--only-subtitles')?[]:datasets){
   const s=cloud.datasets.find((v:any)=>v.dataset===dataset);let cursor=s.cursor??undefined;let generation=cursor?s.generation:randomUUID();let previous=s.previous;let done=false,count=0;let highest=checkpoints.history_pending_max??checkpoints.history??null;const cutoff=dataset==='history'&&!cursor?checkpoints.history:null;
   try{
    do{
     if(pages>=maxPages)break;
     const page=await adapter.page(dataset,cursor);const items=page.items.map(v=>recordSchema.parse(v));
     if(dataset==='history')for(const r of items)if(r.source_time&&(!highest||r.source_time>highest))highest=r.source_time;
     const overlap=cutoff&&items.length>0&&items.every(r=>r.source_time&&r.source_time<=cutoff);
     const next=overlap?null:page.next_cursor??null;
     pending={op:'page',page_id:randomUUID(),dataset,epoch:cloud.sync_epoch,generation,previous,items,next_cursor:next,snapshot:page.snapshot};
     await atomic(pendingPath,pending);const ack=await request(pending);if(ack.page_id!==pending.page_id)throw new Error('PAGE_ACK_MISMATCH');await unlink(pendingPath);pending=null;
     previous=ack.page_id;cursor=next??undefined;pages++;count+=items.length;done=next===null;if(dataset==='history'){checkpoints.history_pending_max=highest;await atomic(checkpointPath,checkpoints);}await delay(650);
    }while(!done);
    if(dataset==='history'&&done){checkpoints.history=highest;delete checkpoints.history_pending_max;await atomic(checkpointPath,checkpoints);}
    results.push({dataset,status:done?'synced':'partial',records_uploaded:count});
   }catch(error){const code=error instanceof AppError?error.code:error instanceof Error&&/^[A-Z_0-9]{3,80}$/.test(error.message)?error.message:'LOCAL_SYNC_FAILED';results.push({dataset,status:'failed',code,records_uploaded:count});if(['AUTH_EXPIRED','RISK_CONTROLLED','RATE_LIMITED','UPSTREAM_CHANGED','UPSTREAM_UNAVAILABLE','PERMISSION_DENIED'].includes(code))await request({op:'fail',dataset,code}).catch(()=>{});if(pending||['AUTH_EXPIRED','RISK_CONTROLLED','RATE_LIMITED','SYNC_PAUSED_BY_OWNER'].includes(code))break;}
  }
  console.log(JSON.stringify({status:results.every(r=>r.status==='synced')&&subtitleResults.every(r=>r.status==='synced')?'synced':'partial',pages,results,subtitle_results:subtitleResults,completed_at:new Date().toISOString()}));
 }finally{await lock.close();await unlink(lockPath);}
}
main().catch(error=>{console.log(JSON.stringify({status:'failed',code:error instanceof Error&&/^[A-Z_0-9]{3,80}$/.test(error.message)?error.message:'LOCAL_COLLECTOR_FAILED'}));process.exitCode=1;});
