import { env } from "cloudflare:workers";
import { gatewayHealth, gatewayStatus, PLATFORMS, type GatewayConfig } from "@/lib/gateway-core";
import { requireChatGPTUser } from "./chatgpt-auth";
import { MediaService } from '@/lib/cloud/service';
import { dandanplaySummary } from '@/lib/cloud/dandanplay';
import { ServiceCheck } from '@/components/service-check-server';
export const dynamic = "force-dynamic";
const names = { steam: "Steam", bilibili: "Bilibili", netease: "网易云音乐", dandanplay: "弹弹play" };
const details = { steam: "游戏库 · 成就查询 · 投入记录", bilibili: "历史 · 收藏 · 互动 · 稍后再看", netease: "歌单 · 听歌排行 · 收听统计", dandanplay: "追番状态 · 分集记录 · 观看进度" };
const symbols = { steam: "↗", bilibili: "▥", netease: "♪", dandanplay: "▷" };
const syncOptions = { steam: [['owned_games', '游戏库'], ['recent_games', '最近游玩']], bilibili: [['history', '观看记录'], ['favorite_folders', '收藏夹'], ['favorites', '收藏视频']], netease: [['favorites', '红心歌曲'], ['user_record_all', '长期排行'], ['user_record_week', '本周排行'], ['recent_plays', '最近播放'], ['playlists', '歌单目录'], ['playlist_tracks', '歌单歌曲'], ['listening_stats', '收听统计']], dandanplay: [] };
export default async function Home({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const checked = (await searchParams)?.check === '1';
  const user = await requireChatGPTUser("/");
  const service = new MediaService(env as GatewayConfig);
  await service.store.owner(user.userId);
  const [health, sync] = await Promise.all([gatewayHealth(env as GatewayConfig), gatewayStatus(env as GatewayConfig, [...PLATFORMS])]);
  const connected = health.backend_status === "connected";
  const states = (sync.platforms ?? []) as Array<{ platform: string; configured?: boolean; state?: string; last_successful_sync_at?: string | null; records?: number | null; datasets?: Array<{dataset:string;state:string;error_code?:string|null}>; watchlist_summary?: ReturnType<typeof dandanplaySummary> | null }>;
  const anime = states.find(item => item.platform === 'dandanplay')?.watchlist_summary;
  return <main className="shell">
    <nav className="topbar"><a className="brand" href="/"><span className="brand-mark">m<span>·</span></span><span>PERSONAL MEDIA<span className="brand-sub">你的个人兴趣空间</span></span></a><div className="private-pill"><span className="tiny-dot" />私人空间</div></nav>
    <section className="intro"><div className="eyebrow"><span /> RECORDS INTO CONNECTIONS</div><h1>每一份热爱，<br /><span>都值得被串联。</span></h1><p>从游戏里的投入，到音乐中的共鸣。<br />让视频、歌曲与动画记录，成为下一次发现的起点。</p><div className="intro-bottom"><a className="primary-button" href="#platforms">查看数据源 <span>↗</span></a><span className="intro-note">四个平台 · 同一个你</span></div><div className="orbit" aria-hidden="true"><span className="orbit-label o1">PLAY</span><span className="orbit-label o2">LISTEN</span><span className="orbit-label o3">WATCH</span><span className="orbit-core">m<span>·</span></span><span className="orbit-ring r1"/><span className="orbit-ring r2"/></div></section>
    <div className="discovery-entry"><a href="/timeline">查看媒体时间轴 <span>↗</span></a><a href="/discover">查找作品关联与视频推荐 <span>↗</span></a><a href="/data">管理我的数据 <span>↗</span></a></div>
    <section className="overview"><div><span className="section-kicker">连接状态</span><h2>{connected ? "数据服务已连接" : "入口已就绪，等待连接数据"}</h2><p>{connected ? "各平台的数据范围与更新时间会分别显示。" : "首次同步完成后，这里会显示真实记录和最近同步时间。"}</p></div><a className="refresh-link" href="/">刷新状态 <span>↻</span></a></section>
    <section id="platforms" className="platform-grid" aria-label="平台同步状态">{PLATFORMS.map((platform, index) => {
      const state = states.find((item) => item.platform === platform);
      const success = state?.last_successful_sync_at;
      const riskControlled = state?.datasets?.some(dataset => dataset.error_code === 'RISK_CONTROLLED');
      const status = state?.state === 'paused' ? '已暂停同步' : riskControlled ? '平台限制访问' : state?.state === "failed" || state?.state === "unavailable" ? "暂不可用" : state?.state === 'partial' ? '部分同步' : success ? "已同步" : state?.state === 'not_configured' ? '未连接' : connected ? "等待首次同步" : "未连接";
      return <article className={`platform-card ${platform}`} key={platform}><div className="card-top"><span className="platform-symbol" aria-hidden="true">{symbols[platform]}</span><span className="card-index">0{index + 1}</span></div><h3>{names[platform]}</h3><p>{details[platform]}</p><div className="card-status"><span className={success ? "status success" : "status"}><span />{status}</span><span className="record-count">{typeof state?.records === "number" ? `${state.records.toLocaleString("zh-CN")} 条记录` : "暂无同步记录"}</span></div><div className="sync-time">最近成功同步<span>{success ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(success)) : "—"}</span></div>{state?.state !== 'paused' && state?.configured && !(platform === 'bilibili' && (env as GatewayConfig).PMA_BILI_INGEST_TOKEN) && syncOptions[platform].length > 0 && <div className="platform-sync-actions">{syncOptions[platform].map(([dataset,label]) => <form method="post" action="/api/sync-platform" key={dataset}><input type="hidden" name="platform" value={platform}/><input type="hidden" name="dataset" value={dataset}/><button type="submit">{state.datasets?.find(row => row.dataset === dataset)?.state === 'partial' ? '继续同步' : '同步'}{label}</button></form>)}</div>}{platform === 'bilibili' && (env as GatewayConfig).PMA_BILI_INGEST_TOKEN && <p className="local-sync-note">本机读取后同步；电脑离线时可查询已上传记录。</p>}</article>;
    })}</section>
    <section id="records" className="workspace-tools" aria-label="个人记录与连接检查"><div className="snapshot-panel"><span className="section-kicker">弹弹play</span><h3>你的番剧快照</h3>{anime ? <><div className="snapshot-counts"><div><strong>{anime.following}</strong><span>已关注</span></div><div><strong>{anime.following_completion.not_completed}</strong><span>未看完</span></div><div><strong>{anime.following_completion.completed}</strong><span>已看完</span></div><div><strong>{anime.following_completion.abandoned}</strong><span>已放弃</span></div></div><p>关注番剧的当前状态 · 个人已评分 {anime.personal_ratings.rated} 部，未评分 {anime.personal_ratings.unrated} 部。</p><p>你的评分：10 非常好看 · 8 挺好看的 · 6 勉强能看下去 · 0 未评分。</p></> : <p>首次同步后显示关注与完成状态。</p>}</div><ServiceCheck checked={checked} completed={anime?.following_completion.completed ?? null} /></section>
    <section className="principles"><div><span className="small-icon">◎</span><h3>从真实记录出发</h3><p>拥有、看过、收藏与喜欢，分别保留各自的含义。</p></div><div><span className="small-icon">↝</span><h3>发现意料之外的关联</h3><p>让一款游戏，带你找到一首歌、一期视频或一部动画。</p></div><div><span className="small-icon">◷</span><h3>知道数据更新到何时</h3><p>每个平台单独显示同步状态，旧记录与新发现都有据可查。</p></div></section>
    <footer><span>PERSONAL MEDIA ASSISTANT</span><span>留住投入，继续发现。</span></footer>
  </main>;
}
