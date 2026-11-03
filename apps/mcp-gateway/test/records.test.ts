import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateTestDatabase } from './migrations.ts';
import { CloudStore } from '../lib/cloud/store.ts';
import { MediaService } from '../lib/cloud/service.ts';
import { recordSchema, type MediaRecord } from '../lib/cloud/contracts.ts';
import { crossPlatformTimeline, steamPlaytimeHistory } from '../lib/cloud/timeline.ts';
import { deletionPreview, deletePersonalData, resumeSync } from '../lib/cloud/data-management.ts';
import { manageDataFromWeb } from '../lib/cloud/web-data.ts';
import { exportLines } from '../lib/cloud/export.ts';
import { handleMcp, tools } from '../lib/gateway-core.ts';
import { receiveBilibili } from '../lib/cloud/bilibili-collector.ts';
import { BilibiliAdapter } from '../lib/cloud/adapters.ts';
const secret = 'test-only-record-management-key-not-a-real-secret';
class Statement {
  values: any[] = [];
  constructor(public sql: DatabaseSync, public query: string) {}
  bind(...args: any[]) { const next = new Statement(this.sql, this.query); next.values = args; return next; }
  async first(column?: string) { const row = this.sql.prepare(this.query).get(...this.values); return column ? row?.[column] ?? null : row ?? null; }
  execute() { return { success: true, results: this.sql.prepare(this.query).all(...this.values), meta: {} }; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
function fixture() {
  const sql = new DatabaseSync(':memory:'); migrateTestDatabase(sql);
  const db = { prepare: (q: string) => new Statement(sql, q), batch: async (s: Statement[]) => { sql.exec('BEGIN'); try { const r = s.map(v => v.execute()); sql.exec('COMMIT'); return r; } catch (e) { sql.exec('ROLLBACK'); throw e; } } } as unknown as D1Database;
  const env = { DB: db, PMA_CURSOR_KEY: secret, PMA_INGEST_DEVICE_ID: 'fixture-device', PMA_INGEST_TOKEN: 'fixture-ingest-token-long-enough-for-tests' };
  return { sql, db, store: new CloudStore(db, secret), env };
}
const rec = (id: string, extra: Record<string, unknown> = {}) => recordSchema.parse({ platform: 'dandanplay', dataset: 'episodes', id, content_id: id, title: 'Fixture ' + id, record_kind: 'last_watch_observation', collected_at: '2026-11-03T00:00:00Z', ...extra });
async function save(store: CloudStore, items: MediaRecord[]) { for (const r of items) await store.page(r.platform, r.dataset, [r], null, 'fixture', false, 'synthetic test'); }
const range = { after: '2026-11-01T00:00:00Z', before: '2026-11-04T00:00:00Z' };
const upload=(extra:Record<string,unknown>={})=>({schema_version:'1.0',device_id:'fixture-device',op:'page',page_id:crypto.randomUUID(),generation:crypto.randomUUID(),dataset:'history',epoch:'initial',previous:null,items:[rec('BV0000000001',{platform:'bilibili',dataset:'history'})],next_cursor:null,snapshot:false,...extra});
async function confirm(store: CloudStore, scope: 'steam'|'bilibili'|'netease'|'dandanplay'|'all') { const p = await deletionPreview(store, { scope }); return { scope, token: p.token, confirmation: p.confirmation_required }; }

test('时间轴分轨，不把无日期完成、排行和最近列表写成播放事件', async () => {
  const f = fixture(); try {
    await save(f.store, [rec('watched', {source_time:'2026-11-02T00:00:00Z',source_time_semantics:'last_watch'}),
      rec('undated-completed', {dataset:'watchlist',record_kind:'completion_assertion',completion_state:'completed',completion_basis:'explicit_source_status',all_episodes_completed:true}),
      rec('favorite', {platform:'bilibili',dataset:'favorites',record_kind:'collection_state',source_time:'2026-11-02T03:00:00Z',source_time_semantics:'collection_time'}),
      rec('recent', {platform:'netease',dataset:'recent_plays',record_kind:'recent_play_list_item',source_time:'2026-11-02T01:00:00Z',source_time_semantics:'recent_list_time_unverified'}),
      rec('ranking', {platform:'netease',dataset:'user_record_week',record_kind:'period_statistic'}),
      rec('unknown-observation'), rec('library', {platform:'steam',dataset:'owned_games',record_kind:'library_snapshot',playtime_minutes:100})]);
    const result = await crossPlatformTimeline(f.store, range);
    assert.equal(result.items.length,5);
    const completed = result.items.find(r => r.content_id==='undated-completed')!; assert.equal(completed.lane,'collection_snapshot');assert.equal(completed.at,'2026-11-03T00:00:00.000Z');assert.equal(completed.all_episodes_completed,true);
    assert.equal(result.items.find(r=>r.content_id==='watched')!.lane,'last_observation');
    assert.equal(result.items.find(r=>r.content_id==='recent')!.lane,'unverified_recent_list');assert.equal(result.items.find(r=>r.content_id==='ranking')!.lane,'ranking_snapshot');
    const observations = await crossPlatformTimeline(f.store, {...range,lanes:['last_observation','collection']}); assert.deepEqual(observations.items.map(r=>r.content_id),['favorite','watched']);
  } finally { f.sql.close(); }
});
test('时间轴先按日期与来源过滤、稳定续页并绑定全部筛选条件', async () => {
  const f=fixture();try {
    await save(f.store,Array.from({length:12},(_,i)=>rec(String(i).padStart(2,'0'),{source_time:'2026-11-02T08:00:00+08:00',source_time_semantics:'last_watch',title:i%2?'other':'target'})));
    await save(f.store,[rec('outside',{source_time:'2026-11-03T00:00:00Z',source_time_semantics:'last_watch'})]);
    const q={after:'2026-11-02T08:00:00+08:00',before:'2026-11-03T08:00:00+08:00',platforms:['dandanplay'],keyword:'target',limit:2};
    const first=await crossPlatformTimeline(f.store,q),second=await crossPlatformTimeline(f.store,{...q,cursor:first.next_cursor});
    assert.deepEqual([...first.items,...second.items].map(r=>r.content_id),['00','02','04','06']);
    assert.deepEqual(JSON.parse(JSON.stringify(first.lane_totals)),[{lane:'last_observation',records:6}]);
    await assert.rejects(crossPlatformTimeline(f.store,{...q,keyword:'other',cursor:first.next_cursor}),/INVALID_CURSOR/);
    await assert.rejects(crossPlatformTimeline(f.store,{...q,cursor:first.next_cursor+'x'}),/INVALID_CURSOR/);
    await assert.rejects(crossPlatformTimeline(f.store,{after:range.before,before:range.after}));
  }finally{f.sql.close();}
});
test('时间轴限制响应体，单来源失败和无缓存来源明确显示缺口',async()=>{
  const f=fixture();try{
    const long='测'.repeat(580);await save(f.store,Array.from({length:60},(_,i)=>rec(String(i),{title:long,source_time:'2026-11-02T00:00:00Z',source_time_semantics:'last_watch'})));
    await f.store.fail('bilibili','history','RISK_CONTROLLED');
    const r=await crossPlatformTimeline(f.store,{...range,limit:50});assert.ok(Buffer.byteLength(JSON.stringify(r))<16384);assert.equal(r.has_more,true);assert.equal(r.status,'partial');
    assert.equal((r.sources.find(s=>s.platform==='bilibili')!.datasets[0] as any).error_code,'RISK_CONTROLLED');
    const empty=await crossPlatformTimeline(f.store,{...range,platforms:['steam']});assert.equal(empty.items.length,0);assert.equal(empty.status,'partial');
  }finally{f.sql.close();}
});
test('只有完整Steam库提交后保留每日最后样本，续页不留下半份历史',async()=>{
  const f=fixture();try{
    const game=(id:string,n:number)=>rec(id,{platform:'steam',dataset:'owned_games',record_kind:'library_snapshot',playtime_minutes:n});
    await f.store.page('steam','owned_games',[game('1',100)],{offset:1},'generation-1',true,'fixture');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM steam_playtime_samples').get()!.n,0);
    await f.store.page('steam','owned_games',[game('2',200)],null,'generation-1',true,'fixture');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM steam_playtime_samples').get()!.n,2);
    await f.store.page('steam','owned_games',[game('1',150)],null,'generation-2',true,'fixture');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM steam_playtime_samples').get()!.n,1);assert.equal(f.sql.prepare('SELECT playtime_minutes n FROM steam_playtime_samples').get()!.n,150);
    const date=new Date(); const r=await crossPlatformTimeline(f.store,{after:new Date(date.getTime()-86400000).toISOString(),before:new Date(date.getTime()+86400000).toISOString(),lanes:['library_sample']});assert.equal(r.items[0].cumulative_minutes,150);assert.equal(r.items[0].sampled_games,1);
  }finally{f.sql.close();}
});
test('Steam相邻样本差值包含区间基线，计数回退不输出负游戏时间',async()=>{
  const f=fixture();try{
    const add=f.sql.prepare('INSERT INTO steam_playtime_samples VALUES(?,?,?,?,?)');
    for(const [day,n] of [['2026-11-01',100],['2026-11-02',160],['2026-11-03',140]] as const)add.run(day,'42','Fixture Game',n,day+'T01:00:00.000Z');
    const r=await steamPlaytimeHistory(f.store,{app_id:'42',after:'2026-11-02T00:00:00Z',limit:1});assert.equal(r.items[0].observed_increment_minutes,null);assert.equal(r.items[0].cumulative_counter_decreased,true);
    const next=await steamPlaytimeHistory(f.store,{app_id:'42',after:'2026-11-02T00:00:00Z',limit:1,cursor:r.next_cursor});assert.equal(next.items[0].observed_increment_minutes,60);assert.equal(next.items[0].previous_sample_at,'2026-11-01T01:00:00.000Z');assert.equal(r.trend.status,'observed_intervals_available');assert.equal(r.trend.observed_increase_minutes,60);assert.equal(r.trend.counter_decreases,1);assert.equal(r.trend.earliest_interval_baseline_at,'2026-11-01T01:00:00.000Z');assert.deepEqual(r.trend,next.trend);const first=await steamPlaytimeHistory(f.store,{app_id:'42',before:'2026-11-02T00:00:00Z'});assert.equal(first.trend.status,'insufficient_samples');assert.equal(first.trend.observed_increase_minutes,null);
    await assert.rejects(steamPlaytimeHistory(f.store,{app_id:'43',cursor:r.next_cursor}),/INVALID_CURSOR/);
  }finally{f.sql.close();}
});
test('删除预览只读，MCP需要本人认证并正确标注破坏性',async()=>{
  const f=fixture();try{
    await f.store.owner('owner');await save(f.store,[rec('one')]);const p=await deletionPreview(f.store,{scope:'all'});assert.equal(p.records[0].records,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM data_deletions').get()!.n,0);
    const req={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'prepare_personal_data_deletion',arguments:{scope:'all'}}};assert.equal((await handleMcp(req,null,f.env)).http,401);
    const denied:any=(await handleMcp(req,'not-owner',f.env)).body;assert.equal(JSON.parse(denied.result.content[0].text).code,'OWNER_ONLY');
    const deletion=tools.find(t=>t.name==='delete_personal_data')!;assert.equal(deletion.annotations.destructiveHint,true);assert.equal(deletion.annotations.readOnlyHint,false);
  }finally{f.sql.close();}
});
test('按平台删除记录、反馈、样本与游标并暂停，不影响其他平台或登录',async()=>{
  const f=fixture();try{
    await f.store.owner('owner');await f.store.instance();await save(f.store,[rec('keep'),rec('42',{platform:'steam',dataset:'owned_games',record_kind:'library_snapshot',playtime_minutes:100})]);
    f.sql.prepare('INSERT INTO steam_playtime_samples VALUES(?,?,?,?,?)').run('2026-11-02','42','Fixture',100,'2026-11-02T01:00:00Z');
    const svc=new MediaService(f.env);await svc.call('save_recommendation_feedback',{request_id:'feedback-fixture-1',platform:'steam',content_id:'42',feedback:'like'});
    const r=await deletePersonalData(f.store,await confirm(f.store,'steam'));assert.equal(r.deleted,true);assert.equal((await f.store.control('steam')).sync_paused,true);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM media_records WHERE platform='steam'").get()!.n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM steam_playtime_samples').get()!.n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_feedback').get()!.n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,1);
    assert.equal((await f.store.state('steam','owned_games')),null);await f.store.owner('owner');assert.ok(await f.store.instance());
    let fetched=false;const service=new MediaService({...f.env,STEAM_ID:'12345678901234567',STEAM_API_KEY:'fixture'},(async()=>{fetched=true;throw new Error('should not fetch');}) as typeof fetch);
    await assert.rejects(service.sync({platform:'steam',dataset:'owned_games'}),/SYNC_PAUSED_BY_OWNER/);assert.equal(fetched,false);
  }finally{f.sql.close();}
});
test('删除令牌绑定范围、期限和确认文字，重复令牌不会再次删除恢复后的新数据',async()=>{
  const f=fixture();try{
    const q=await confirm(f.store,'dandanplay');await assert.rejects(deletePersonalData(f.store,{...q,confirmation:'wrong'}),/DELETION_CONFIRMATION_REQUIRED/);await assert.rejects(deletePersonalData(f.store,{...q,scope:'all',confirmation:'DELETE all'}),/DELETION_TOKEN_INVALID/);await assert.rejects(deletePersonalData(f.store,{...q,token:q.token+'x'}),/DELETION_TOKEN_INVALID/);
    await assert.rejects(deletePersonalData(f.store,q,Date.now()+601000),/DELETION_TOKEN_INVALID/);
    await deletePersonalData(f.store,q);const epoch=(await f.store.control('dandanplay')).sync_epoch;await resumeSync(f.store,{platform:'dandanplay'});assert.equal((await f.store.control('dandanplay')).sync_epoch,epoch);
    await save(f.store,[rec('new')]);assert.equal((await deletePersonalData(f.store,q)).duplicate,true);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,1);assert.equal((await f.store.control('dandanplay')).sync_paused,false);
  }finally{f.sql.close();}
});
test('删除失败会原子回滚，不能留下已删回执或假暂停',async()=>{
  const f=fixture();try{await save(f.store,[rec('keep')]);f.sql.exec("CREATE TRIGGER fixture_failure BEFORE DELETE ON media_records BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");await assert.rejects(deletePersonalData(f.store,await confirm(f.store,'all')),/fixture_failure/);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM data_deletions').get()!.n,0);assert.equal((await f.store.control('dandanplay')).sync_paused,false);
  }finally{f.sql.close();}
});
test('正在进行的Steam页写入与删除交错时，不能重新填回记录或样本',async()=>{
  const f=fixture();try{
    const q=await confirm(f.store,'steam');let deleted=false;
    const db={prepare:f.db.prepare.bind(f.db),batch:async(s:D1PreparedStatement[])=>{if(!deleted){deleted=true;await deletePersonalData(f.store,q);}return f.db.batch(s);}} as D1Database;
    const racing=new CloudStore(db,secret);await assert.rejects(racing.page('steam','owned_games',[rec('42',{platform:'steam',dataset:'owned_games',record_kind:'library_snapshot',playtime_minutes:100})],null,'in-flight',true,'fixture'),/SYNC_PAUSED_BY_OWNER/);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM steam_playtime_samples').get()!.n,0);assert.equal(await f.store.state('steam','owned_games'),null);
    await f.store.fail('steam','owned_games','UPSTREAM_UNAVAILABLE');assert.equal(await f.store.state('steam','owned_games'),null);
  }finally{f.sql.close();}
});
test('正在进行的采集批次与删除交错时，不留下批次、状态或评分元数据',async()=>{
  const f=fixture();try{
    const q=await confirm(f.store,'dandanplay');let deleted=false;
    const db={prepare:f.db.prepare.bind(f.db),batch:async(s:D1PreparedStatement[])=>{if(!deleted){deleted=true;await deletePersonalData(f.store,q);}return f.db.batch(s);}} as D1Database;
    const racing=new CloudStore(db,secret);await assert.rejects(racing.ingest({device_id:'fixture-device',batch_id:'fixture-race-1',items:[rec('one',{dataset:'watchlist',record_kind:'collection_state'})]}),/SYNC_PAUSED_BY_OWNER/);
    for(const table of ['media_records','collector_batches','platform_sync_state'])assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM pma_meta WHERE key='dandanplay_rating_scale'").get()!.n,0);
  }finally{f.sql.close();}
});
test('删除网页拒绝跨站、匿名、非本人、重复字段及未勾选确认',async()=>{
  const f=fixture();try{
    await f.store.owner('owner');await save(f.store,[rec('keep')]);const q=await confirm(f.store,'dandanplay');
    const form=new URLSearchParams({...q,action:'delete',confirmed:'yes'}).toString();
    const request=(body=form,origin='https://fixture.test')=>new Request('https://fixture.test/api/manage-data',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body});
    await assert.rejects(manageDataFromWeb(request(),null,f.env),/AUTH_REQUIRED/);await assert.rejects(manageDataFromWeb(request(),'wrong',f.env),/OWNER_ONLY/);await assert.rejects(manageDataFromWeb(request(form,'https://other.test'),'owner',f.env),/ORIGIN_DENIED/);
    await assert.rejects(manageDataFromWeb(request(form+'&scope=all'),'owner',f.env),/INVALID_ARGUMENTS/);await assert.rejects(manageDataFromWeb(request(form.replace('&confirmed=yes','')),'owner',f.env));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,1);
    await manageDataFromWeb(request(),'owner',f.env);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,0);assert.equal((await f.store.control('dandanplay')).sync_paused,true);
  }finally{f.sql.close();}
});
test('私有导出分页包含时长样本，不输出暂停代次或删除令牌',async()=>{
  const f=fixture();try{
    await save(f.store,[rec('keep')]);for(const id of ['42','43'])f.sql.prepare('INSERT INTO steam_playtime_samples VALUES(?,?,?,?,?)').run('2026-11-02',id,'Fixture',100,'2026-11-02T00:00:00Z');
    const rows:any[]=[];let cursor:string|undefined;
    do {const page:any[]=[];for await(const row of exportLines(f.store,{max_records:1,...(cursor?{cursor}:{})}))page.push(row);rows.push(...page.filter(r=>!['manifest','end'].includes(r.type)));cursor=page.at(-1).next_cursor??undefined;}while(cursor);
    assert.equal(rows.filter(r=>r.type==='record').length,1);assert.equal(rows.filter(r=>r.type==='steam_playtime_sample').length,2);assert.equal(JSON.stringify(rows).includes('sync_epoch'),false);
  }finally{f.sql.close();}
});
test('采集心跳分开报告暂停与代次，恢复同步不会自动声称已同步',async()=>{
  const f=fixture();try{
    const svc=new MediaService(f.env);const hb={schema_version:'1.0',device_id:'fixture-device',heartbeat:true};assert.equal((await svc.heartbeat(hb)).collector_control.sync_epoch,'initial');await deletePersonalData(f.store,await confirm(f.store,'dandanplay'));assert.equal((await svc.heartbeat(hb)).collector_control.sync_paused,true);await resumeSync(f.store,{platform:'dandanplay'});const status=await f.store.status(svc.configured());assert.equal(status.platforms.find(p=>p.platform==='dandanplay')!.state,'not_synced');assert.equal((await svc.heartbeat(hb)).collector_control.sync_paused,false);
  }finally{f.sql.close();}
});
test('B站上传只允许指定设备、数据集及规范化字段',async()=>{
 const f=fixture();try{
  await assert.rejects(receiveBilibili(f.store,'other-device',upload()),/DEVICE_SCOPE_DENIED/);
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload({items:[rec('other')]})));
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload({snapshot:true})));
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload({cookie:'not-allowed'})));
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload({dataset:'likes',snapshot:true})));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,0);
 }finally{f.sql.close();}
});
test('B站快照分页、游标、去重回执与数据一同提交，末页才清理旧集合',async()=>{
 const f=fixture();try{
  await save(f.store,[rec('old',{platform:'bilibili',dataset:'favorites',record_kind:'collection_state'})]);
  const a=upload({dataset:'favorites',snapshot:true,items:[rec('new',{platform:'bilibili',dataset:'favorites',record_kind:'collection_state'})],next_cursor:{page:2}});
  await receiveBilibili(f.store,'fixture-device',a);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,2);
  assert.equal((await receiveBilibili(f.store,'fixture-device',a)).duplicate,true);
  await assert.rejects(receiveBilibili(f.store,'fixture-device',{...a,items:[]}),/PAGE_ID_CONFLICT/);
  await assert.rejects(receiveBilibili(f.store,'fixture-device',{...a,page_id:crypto.randomUUID(),previous:a.page_id,generation:crypto.randomUUID()}),/COLLECTOR_GENERATION_CHANGED/);
  await receiveBilibili(f.store,'fixture-device',{...a,page_id:crypto.randomUUID(),previous:a.page_id,items:[],next_cursor:null});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,1);assert.equal((await f.store.state('bilibili','favorites'))!.state,'synced');
 }finally{f.sql.close();}
});
test('B站上传失败原子回滚，乱序页不能覆盖游标',async()=>{
 const f=fixture();try{
  const a=upload();await receiveBilibili(f.store,'fixture-device',a);
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload()),/COLLECTOR_SEQUENCE_CHANGED/);
  f.sql.exec("CREATE TRIGGER upload_failure BEFORE INSERT ON media_records BEGIN SELECT RAISE(ABORT,'upload_failure'); END;");
  await assert.rejects(receiveBilibili(f.store,'fixture-device',upload({previous:a.page_id})),/upload_failure/);
  const state:any=await receiveBilibili(f.store,'fixture-device',{schema_version:'1.0',device_id:'fixture-device',op:'state'});assert.equal(state.datasets.find((s:any)=>s.dataset==='history').previous,a.page_id);
 }finally{f.sql.close();}
});
test('B站删除后清除上传回执，旧代次在恢复后也不能回填',async()=>{
 const f=fixture();try{
  const a=upload();await receiveBilibili(f.store,'fixture-device',a);await deletePersonalData(f.store,await confirm(f.store,'bilibili'));await resumeSync(f.store,{platform:'bilibili'});
  await assert.rejects(receiveBilibili(f.store,'fixture-device',a),/COLLECTOR_EPOCH_CHANGED/);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM pma_meta WHERE key LIKE 'bili_collector:%'").get()!.n,0);
 }finally{f.sql.close();}
});
test('B站上传与删除交错时不能遗留回执或数据',async()=>{
 const f=fixture();try{const q=await confirm(f.store,'bilibili');let deleted=false;const db={prepare:f.db.prepare.bind(f.db),batch:async(s:D1PreparedStatement[])=>{if(!deleted){deleted=true;await deletePersonalData(f.store,q);}return f.db.batch(s);}} as D1Database;await assert.rejects(receiveBilibili(new CloudStore(db,secret),'fixture-device',upload()));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_records').get()!.n,0);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM pma_meta WHERE key LIKE 'bili_collector:%'").get()!.n,0);}finally{f.sql.close();}
});
test('点赞缺少时间保持未知，投币保留本人数量与time，不采用ctime或全站stat.coin',async()=>{
 const fetcher=(async(input:any)=>{const u=new URL(input.toString());if(u.pathname.endsWith('/nav'))return Response.json({code:0,data:{isLogin:true,mid:123}});const coin=u.pathname.includes('/coin/');const video={bvid:'BV0000000001',state:0,title:'Fixture',pubdate:1700000000,ctime:1700000000,owner:{mid:10,name:'Fixture'},coins:2,time:1762041600,stat:{coin:99999}};return Response.json({code:0,data:coin?[video]:{list:[video]}});}) as typeof fetch;
 const adapter=new BilibiliAdapter({biliCookie:'SESSDATA=fixture; buvid3=fixture'},fetcher);
 const like=(await adapter.page('likes')).items[0],coin=(await adapter.page('coins')).items[0];assert.equal(like.source_time,undefined);assert.equal(like.source_time_semantics,'unknown');assert.equal(like.interaction,'like');assert.equal(coin.coins_given,2);assert.equal(coin.source_time_semantics,'coin_time');assert.notEqual(coin.source_time,coin.published_at);
 const f=fixture();try{await save(f.store,[like,coin]);const r:any=await new MediaService(f.env).call('bilibili_get_recent_interactions',{action:'like'});assert.equal(r.items.length,1);assert.equal(r.items[0].interaction,'like');}finally{f.sql.close();}
});
test('启用本机B站采集时，云端同步不再触发受限源请求',async()=>{
 const f=fixture();try{let called=false;const s=new MediaService({...f.env,PMA_BILI_INGEST_TOKEN:'fixture'},(async()=>{called=true;throw new Error();}) as typeof fetch);await assert.rejects(s.sync({platform:'bilibili',dataset:'history'}),/LOCAL_COLLECTOR_REQUIRED/);assert.equal(called,false);}finally{f.sql.close();}
});
test('收藏标题中的书名尖括号不是HTML，明确空收藏夹才接受null媒体列表',async()=>{
 const adapter=new BilibiliAdapter({biliCookie:'SESSDATA=fixture; buvid3=fixture'},(async()=>Response.json({code:0,data:{has_more:false,info:{media_count:0},medias:null}})) as typeof fetch);
 assert.equal(adapter.video({bvid:'BV0000000001',title:'<Fixture Song>'},'favorites').title,'<Fixture Song>');
 assert.equal(adapter.video({bvid:'BV0000000001',title:'<em class="keyword">Fixture</em> Song'},'search_results').title,'Fixture Song');
 const page=await adapter.page('favorites',{folders:['1'],index:0,page:1});assert.equal(page.items.length,0);assert.equal(page.next_cursor,undefined);
 const broken=new BilibiliAdapter({biliCookie:'SESSDATA=fixture; buvid3=fixture'},(async()=>Response.json({code:0,data:{has_more:false,info:{media_count:1},medias:null}})) as typeof fetch);
 await assert.rejects(broken.page('favorites',{folders:['1'],index:0,page:1}),/UPSTREAM_CHANGED/);
});
