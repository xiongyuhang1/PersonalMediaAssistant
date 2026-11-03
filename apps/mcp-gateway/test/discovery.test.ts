import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { CloudStore } from '../lib/cloud/store.ts';
import { recordSchema, type MediaRecord, type Platform } from '../lib/cloud/contracts.ts';
import { AppError } from '../lib/cloud/security.ts';
import { BilibiliAdapter } from '../lib/cloud/adapters.ts';
import { recommendSchema, recommendationSeeds, recommendVideos, searchRelated, workRelated, type DiscoveryClient } from '../lib/cloud/discovery.ts';
import { migrateTestDatabase } from './migrations.ts';
const key = 'test-only-discovery-cursor-key-not-real';
class Statement {
  values: any[] = [];
  constructor(public database: DatabaseSync, public sql: string) {}
  bind(...args: any[]) { const result = new Statement(this.database, this.sql); result.values = args; return result; }
  async first(column?: string) { const row = this.database.prepare(this.sql).get(...this.values); return column ? row?.[column] ?? null : row ?? null; }
  async all() { return this.execute(); }
  async run() { this.database.prepare(this.sql).run(...this.values); return { success: true, results: [], meta: {} }; }
  execute() { return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: {} }; }
}
function fixture() {
  const sql = new DatabaseSync(':memory:'); migrateTestDatabase(sql);
  const db = { prepare: (q: string) => new Statement(sql, q), batch: async (statements: Statement[]) => { sql.exec('BEGIN'); try { const results = statements.map(v => v.execute()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
  return { sql, store: new CloudStore(db, key) };
}
const configured = { steam: true, netease: true, bilibili: true, dandanplay: true };
const now = Date.parse('2026-11-03T00:00:00Z');
const bv = (i: number) => 'BV' + String(i).padStart(10, '0');
const record = (platform: Platform, id: string, extra: Record<string, unknown> = {}) => recordSchema.parse({ platform, id, content_id: id, title: 'Fixture ' + id, dataset: platform === 'steam' ? 'owned_games' : platform === 'netease' ? 'favorites' : platform === 'dandanplay' ? 'watchlist' : 'history', record_kind: 'collection_state', collected_at: '2026-11-02T00:00:00Z', ...extra });
async function save(store: CloudStore, items: MediaRecord[]) { for (const item of items) await store.page(item.platform, item.dataset, [item], undefined, 'fixture', false, 'synthetic fixture'); }
async function seeds(store: CloudStore) { await save(store, [record('steam', '42', {title:'Fixture Game',playtime_minutes:100}), record('netease','43',{title:'Fixture Song',artists:['Fixture Artist'],dataset:'user_record_week',rank:1}), record('dandanplay','44',{title:'Fixture Anime',user_rating:10,user_rating_state:'rated'})]); }
function video(id: number, extra: Record<string, unknown> = {}): MediaRecord { return record('bilibili', bv(id), { dataset:'search_results',record_kind:'media_candidate',title:'Synthetic candidate '+id,uploader_id:'creator-'+id,uploader_name:'Synthetic creator',published_at:'2026-11-01T00:00:00Z',quality:{views:1000,likes:100,coins:20,favorites:50},...extra }); }
function client(fetches: string[] = []): DiscoveryClient {
  return { search: async query => ({ items: Array.from({length:20},(_,i)=>video((query.includes('Fixture Game')?0:query.includes('Fixture Song')?100:query.includes('Fixture Anime')?200:300)+i+1)),has_more:false,warnings:[] }), details: async id => { fetches.push(id); return video(Number(id.slice(2))); } };
}

test('关联仅确认同平台相同ID，跨平台同名/同数字ID保持候选', async () => {
  const f=fixture();try {
    await save(f.store,[record('steam','42',{title:'Fixture Game'}),record('netease','42',{title:'Fixture Game Theme'}),record('netease','43',{title:'A different track',album:'Fixture Game Soundtrack'}),record('bilibili',bv(42),{title:'Fixture Game analysis'})]);
    const result=await searchRelated(f.store,{query:'Fixture Game',source_platform:'steam',source_id:'42'});
    assert.equal(result.items.length,4); assert.equal(result.items.filter(v=>v.confirmed).length,1);
    assert.equal(result.items.find(v=>v.platform==='netease'&&v.content_id==='42')?.confidence,'unverified');
    assert.ok(result.items.find(v=>v.content_id==='43')?.evidence.includes('album_contains_query'));
    const work=await workRelated(f.store,{work_ref:'steam:42'}); assert.equal(work.seed.content_id,'42');
    await assert.rejects(workRelated(f.store,{work_ref:'steam:missing'}),/WORK_NOT_IN_SYNCED_CACHE/);
    await assert.rejects(workRelated(f.store,{work_ref:'https://attacker.test'}));
    await assert.rejects(searchRelated(f.store,{query:'Fixture',source_id:'42'}));
    await assert.rejects(searchRelated(f.store,{query:'!!!'}));
  }finally{f.sql.close();}
});

test('关联按源隔离损坏缓存，并在服务器限量返回',async()=>{
  const f=fixture();try{
    await save(f.store,Array.from({length:25},(_,i)=>record('steam',String(i),{title:'Fixture Game '+i})));
    await save(f.store,[record('netease','bad',{title:'Broken Game'})]);
    f.sql.prepare("UPDATE media_records SET payload='invalid-json' WHERE platform='netease'").run();
    const r=await searchRelated(f.store,{query:'Game',limit:5}); assert.equal(r.items.length,5);assert.equal(r.has_more,true);assert.equal(r.status,'partial');
    assert.equal(r.sources.find(v=>v.platform==='netease')?.status,'partial');assert.equal(r.sources.find(v=>v.platform==='netease')?.invalid_records,1);
  }finally{f.sql.close();}
});

test('评分6和0不作为正向种子，明确上下文优先，全部平台保留状态',async()=>{
  const f=fixture();try{
    await save(f.store,[record('dandanplay','six',{user_rating:6,user_rating_state:'rated'}),record('dandanplay','zero',{user_rating:null,user_rating_state:'unrated'}),record('dandanplay','ten',{user_rating:10,user_rating_state:'rated',title:'Explicitly good anime'})]);
    const r=await recommendationSeeds(f.store,configured,recommendSchema.parse({preference_hints:[{text:'Explicit interest',origin:'user_statement'}]}));
    assert.equal(r.queries[0].query,'Explicit interest');assert.equal(r.sources.length,4);assert.ok(r.queries.some(v=>v.work_ref==='dandanplay:ten'));
    assert.ok(!r.queries.some(v=>v.work_ref==='dandanplay:six'||v.work_ref==='dandanplay:zero'));
    assert.ok(!JSON.stringify(r).includes('last_watched_at'));
  }finally{f.sql.close();}
});

test('排除全缓存中的已看、收藏和负面反馈，不受前20条查询页限制',async()=>{
  const f=fixture();try{
    await seeds(f.store);
    const histories=Array.from({length:150},(_,i)=>record('bilibili',bv(i+1000))); histories.push(record('bilibili',bv(1)));
    await save(f.store,histories);
    await save(f.store,[record('bilibili',bv(2),{dataset:'favorites'})]);
    for(const [id,feedback] of [[3,'dislike'],[4,'seen'],[5,'saved']] as const)f.sql.prepare('INSERT INTO media_feedback VALUES(?,?,?,?,?,?,?)').run('fixture-'+id,'digest','bilibili',bv(id),feedback,null,'2026-11-01T00:00:00Z');
    const fetched:string[]=[];const r=await recommendVideos(f.store,configured,client(fetched),{},now);
    assert.ok(r.items.length>=5);for(const id of [1,2,3,4,5]){assert.ok(!r.items.some(v=>v.content_id===bv(id)));assert.ok(!fetched.includes(bv(id)));}
    assert.ok(r.excluded.seen_or_saved>=4);assert.equal(r.excluded.negative_feedback,1);assert.ok(fetched.length<=14);
    assert.equal(new Set(r.items.map(v=>v.content_id)).size,r.items.length);
  }finally{f.sql.close();}
});

test('最新明确反馈覆盖旧反馈，且不把喜欢伪装成观看事件',async()=>{
  const f=fixture();try{
    await seeds(f.store);
    f.sql.prepare('INSERT INTO media_feedback VALUES(?,?,?,?,?,?,?)').run('old-feedback','digest','bilibili',bv(6),'dislike',null,'2026-01-01T00:00:00Z');
    f.sql.prepare('INSERT INTO media_feedback VALUES(?,?,?,?,?,?,?)').run('new-feedback','digest','bilibili',bv(6),'like',null,'2026-11-01T00:00:00Z');
    const only:DiscoveryClient={search:async()=>({items:[video(6)],has_more:false,warnings:[]}),details:async()=>video(6)};
    const r=await recommendVideos(f.store,configured,only,{exploration_ratio:0},now);
    assert.equal(r.items.length,1);assert.equal(r.items[0].content_id,bv(6));assert.equal(r.exclusion_coverage.cache_ready,false);assert.equal(r.exclusion_coverage.guarantee_unseen,false);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM media_records WHERE platform='bilibili'").get()?.n,0);
  }finally{f.sql.close();}
});

test('详情预算在来源之间交替分配，探索方向和创作者多样性有实际约束',async()=>{
  const f=fixture();try{
    await seeds(f.store);const fetched:string[]=[];const base=client(fetched);
    const c:DiscoveryClient={...base,details:async id=>({...await base.details(id),uploader_id:Number(id.slice(2))<100?'same-creator':'creator-'+id})};
    const r=await recommendVideos(f.store,configured,c,{limit:8},now);
    assert.equal(r.items.length,8);assert.equal(r.exploration.returned,2);assert.ok(fetched.some(v=>Number(v.slice(2))>300));
    assert.ok(r.items.filter(v=>Number(v.content_id.slice(2))<100).length<=2);assert.equal(r.sources.length,4);
  }finally{f.sql.close();}
});

test('风控后立即停止且10分钟内不再请求，不编造视频填满数量',async()=>{
  const f=fixture();try{
    await seeds(f.store);let calls=0;const risky:DiscoveryClient={search:async()=>{calls++;throw new AppError('RISK_CONTROLLED',502);},details:async()=>{throw new Error('must not call');}};
    const first=await recommendVideos(f.store,configured,risky,{},now);assert.equal(calls,1);assert.equal(first.items.length,0);assert.equal(first.status,'unavailable');
    const second=await recommendVideos(f.store,configured,risky,{},now+1000);assert.equal(calls,1);assert.ok(second.errors.includes('RISK_CONTROLLED'));
    await recommendVideos(f.store,configured,risky,{},now+600001);assert.equal(calls,2);
  }finally{f.sql.close();}
});

test('详情不可用或BV不一致不能作为推荐候选，单源损坏保留缺口',async()=>{
  const f=fixture();try{
    await seeds(f.store);f.sql.prepare("UPDATE media_records SET payload='invalid-json' WHERE platform='netease'").run();
    const wrong:DiscoveryClient={search:async()=>({items:[video(1)],has_more:false,warnings:[]}),details:async()=>video(2)};
    const r=await recommendVideos(f.store,configured,wrong,{},now);assert.equal(r.items.length,0);assert.ok(r.errors.includes('UPSTREAM_CHANGED'));assert.equal(r.sources.find(v=>v.platform==='netease')?.status,'unavailable');
  }finally{f.sql.close();}
});

test('缺少认证时不请求B站，预算约束不会泄露大段历史',async()=>{
  const f=fixture();try{
    await seeds(f.store);let called=false;const c:DiscoveryClient={search:async()=>{called=true;throw new Error();},details:async()=>video(1)};
    const r=await recommendVideos(f.store,{...configured,bilibili:false},c,{},now);assert.equal(called,false);assert.equal(r.status,'unavailable');assert.ok(r.errors.includes('AUTH_REQUIRED'));
  }finally{f.sql.close();}
});

test('B站详情核对真实响应ID、可用状态和质量字段，凭据不在URL中',async()=>{
  const fetcher=(async(input:any,init:any)=>{
    const url=new URL(input);assert.equal(url.hostname,'api.bilibili.com');assert.equal(url.searchParams.has('cookie'),false);assert.equal(init.redirect,'manual');
    if(url.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}});
    assert.equal(url.pathname,'/x/web-interface/wbi/view');assert.ok(url.searchParams.has('w_rid'));
    return Response.json({code:0,data:{bvid:bv(1),state:0,title:'Fixture view',owner:{mid:42,name:'Fixture uploader'},stat:{view:123,like:12,coin:3,favorite:4},pubdate:1793404800,duration:60,desc:'Fixture description'}});
  }) as typeof fetch;
  const adapter=new BilibiliAdapter({biliCookie:'SESSDATA=fixture; buvid3=fixture'},fetcher);const r=await adapter.details(bv(1));
  assert.equal(r.content_id,bv(1));assert.equal(r.quality?.views,123);assert.equal(r.uploader_name,'Fixture uploader');assert.equal(r.duration_ms,60000);assert.equal(JSON.stringify(r).includes('SESSDATA'),false);
});

test('大量长字段下关联与推荐响应仍保持16KB内',async()=>{
  const f=fixture();try{
    await seeds(f.store);
    await save(f.store,Array.from({length:20},(_,i)=>record('netease',String(i+500),{title:'音乐'.repeat(200),album:'音乐'.repeat(150),artists:['音乐'.repeat(80),'音乐'.repeat(80),'音乐'.repeat(80)]})));
    const related=await searchRelated(f.store,{query:'音乐',limit:20});assert.ok(Buffer.byteLength(JSON.stringify(related))<16384);
    const base=client();const long:DiscoveryClient={...base,details:async id=>({...await base.details(id),title:'视频标题'.repeat(150),uploader_name:'创作者'.repeat(50),tags:Array.from({length:20},()=> '标签'.repeat(40))})};
    const r=await recommendVideos(f.store,configured,long,{limit:10},now);assert.ok(Buffer.byteLength(JSON.stringify(r))<16384);
  }finally{f.sql.close();}
});

test('搜索中混入无BV的直播卡片时保留真实视频，明确零结果才接受空数组',async()=>{
  let response:any={result:[{bvid:bv(1),title:'Fixture video',typeid:'3'},{bvid:'',title:'Live card',type:'live_room'}],numResults:2,numPages:1};
  const adapter=new BilibiliAdapter({biliCookie:'SESSDATA=fixture; buvid3=fixture'});
  adapter.json=async()=>response;
  const r=await adapter.search('Fixture');assert.equal(r.items.length,1);assert.equal(r.skipped_results,1);assert.equal(r.items[0].category_id,'3');assert.equal(r.items[0].source_time_semantics,'unknown');assert.equal(r.items[0].source_time,undefined);
  response={result:null,numResults:0,numPages:0};assert.equal((await adapter.search('Fixture')).items.length,0);
  response={result:null,numResults:20,numPages:1};await assert.rejects(adapter.search('Fixture'),/UPSTREAM_CHANGED/);
});

test('四个平台都有记录时均能提供检索依据，探索策略不冒充显式偏好',async()=>{
  const f=fixture();try{
    await seeds(f.store);await save(f.store,[record('bilibili',bv(42),{title:'Fixture watched video'})]);
    const r=await recommendationSeeds(f.store,configured,recommendSchema.parse({preference_hints:[{text:'Explicit interest',origin:'user_statement'}]}));
    for(const platform of ['steam','bilibili','netease','dandanplay'])assert.ok(r.queries.some(v=>v.source===platform));
    assert.equal(r.queries[0].source,'explicit_context');assert.equal(r.queries.find(v=>v.exploration)?.source,'exploration_policy');assert.equal(r.queries.length,6);
  }finally{f.sql.close();}
});
