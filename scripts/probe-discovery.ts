// Read-only local integration check against a private normalized export.
// Account cookie arrives through stdin; only video IDs and safe counts are printed.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CloudStore } from '../apps/mcp-gateway/lib/cloud/store.ts';
import { BilibiliAdapter } from '../apps/mcp-gateway/lib/cloud/adapters.ts';
import { recordSchema } from '../apps/mcp-gateway/lib/cloud/contracts.ts';
import { recommendVideos, searchRelated } from '../apps/mcp-gateway/lib/cloud/discovery.ts';
class Statement {
  values: any[] = []; constructor(public database: DatabaseSync, public sql: string) {}
  bind(...args: any[]) { const s=new Statement(this.database,this.sql);s.values=args;return s; }
  async first(column?:string){const r=this.database.prepare(this.sql).get(...this.values);return column?r?.[column]??null:r??null;}
  async all(){return this.execute();}async run(){this.database.prepare(this.sql).run(...this.values);return{success:true,results:[],meta:{}};}
  execute(){return{success:true,results:this.database.prepare(this.sql).all(...this.values),meta:{}};}
}
async function main(){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>20000)throw new Error();}
  const setup=JSON.parse(input);input='';if(typeof setup.BILIBILI_COOKIE!=='string'||!setup.BILIBILI_COOKIE.includes('SESSDATA='))throw new Error();
  const sql=new DatabaseSync(':memory:');for(const entry of JSON.parse(readFileSync('apps/mcp-gateway/drizzle/meta/_journal.json','utf8')).entries)sql.exec(readFileSync(`apps/mcp-gateway/drizzle/${entry.tag}.sql`,'utf8'));
  const db={prepare:(q:string)=>new Statement(sql,q),batch:async(statements:Statement[])=>{sql.exec('BEGIN');try{const r=statements.map(v=>v.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
  try{
    const store=new CloudStore(db,'local-diagnostic-cursor-key-not-used-in-production');let records=0;
    for(const line of readFileSync(process.argv[2],'utf8').split('\n')){
      if(!line.trim())continue;const row=JSON.parse(line);if(row.type!=='record')continue;
      const item=recordSchema.parse(row.record);await store.page(item.platform,item.dataset,[item],undefined,'local-diagnostic',false,'Private normalized export for local verification only');records++;
    }
    const deadline=Date.now()+18000;const client=new BilibiliAdapter({biliCookie:setup.BILIBILI_COOKIE},((url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))})) as typeof fetch);
    const result=await recommendVideos(store,{steam:true,netease:true,dandanplay:true,bilibili:true},client,{});
    const first=await store.db.prepare("SELECT title FROM media_records WHERE platform='steam' ORDER BY id LIMIT 1").first<{title:string}>();
    const related=first?await searchRelated(store,{query:first.title.slice(0,100)}):null;
    const directory=resolve('.local/discovery');mkdirSync(directory,{recursive:true});
    writeFileSync(resolve(directory,'local-verification.json'),JSON.stringify({scope:'local_read_only_not_cloud_acceptance',recommendation:result,related},null,2));
    console.log(JSON.stringify({scope:'local_read_only_not_cloud_acceptance',cached_records:records,status:result.status,real_video_ids:result.items.map(v=>({bvid:v.content_id,url:v.url})),errors:result.errors,queries_executed:result.queries.filter(v=>v.status!=='skipped').length,exploration:result.exploration,response_bytes:Buffer.byteLength(JSON.stringify(result)),related_items:related?.items.length}));
  }finally{sql.close();}
}
main().catch(()=>{console.log(JSON.stringify({code:'LOCAL_DISCOVERY_CHECK_FAILED'}));process.exitCode=1;});
