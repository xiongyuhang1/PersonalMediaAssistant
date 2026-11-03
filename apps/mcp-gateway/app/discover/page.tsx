import { env } from 'cloudflare:workers';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { MediaService, type CloudEnv } from '@/lib/cloud/service';
import { type recommendVideos, type searchRelated } from '@/lib/cloud/discovery';
import { AppError } from '@/lib/cloud/security';
export const dynamic = 'force-dynamic';
const names: Record<string, string> = { steam: 'Steam', bilibili: 'B站', netease: '网易云', dandanplay: '弹弹play', explicit_context: '显式偏好', exploration_policy: '探索策略' };
type Recommendation = Awaited<ReturnType<typeof recommendVideos>>;
type Related = Awaited<ReturnType<typeof searchRelated>>;
export default async function Discover({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireChatGPTUser('/discover'); const service = new MediaService(env as CloudEnv); await service.store.owner(user.userId);
  const params = await searchParams ?? {}; const mode = params.mode; const query = typeof params.query === 'string' ? params.query.trim() : '';
  let recommendation: Recommendation | null = null, related: Related | null = null, unavailable = false;
  try {
    if (mode === 'videos') recommendation = await service.call('recommend_bilibili_videos', { limit: 8, ...(query ? { preference_hints: [{ text: query, origin: 'user_statement' }] } : {}) }) as Recommendation;
    if (mode === 'related') related = await service.call('search_related_media', { query }) as Related;
  } catch (error) { unavailable = true; if (!(error instanceof AppError) && !(error instanceof Error)) throw error; }
  const risk = recommendation?.errors.some(v => ['RISK_CONTROLLED', 'RATE_LIMITED'].includes(v));
  return <main className="shell discover-page">
    <nav className="topbar"><a className="brand" href="/"><span className="brand-mark">m<span>·</span></span><span>PERSONAL MEDIA<span className="brand-sub">你的个人兴趣空间</span></span></a><a className="refresh-link" href="/">返回我的记录 ↗</a></nav>
    <section className="discover-intro"><span className="section-kicker">从记录到发现</span><h1>让下一次发现，<br/>有迹可循。</h1><p>从你投入的游戏、听过的歌曲和评价过的动画出发，寻找值得一看的内容。</p></section>
    <div className="discover-forms"><form method="get" action="/discover"><input type="hidden" name="mode" value="videos"/><label htmlFor="video-query">这次想看什么？</label><input id="video-query" name="query" maxLength={100} defaultValue={mode === 'videos' ? query : ''} placeholder="可留空，或输入游戏OST、动画OP等兴趣词"/><button type="submit">生成视频推荐</button><p>结合已同步记录与本次兴趣词，最多返回8个真实视频。</p></form><form method="get" action="/discover"><input type="hidden" name="mode" value="related"/><label htmlFor="related-query">寻找作品关联</label><input id="related-query" name="query" maxLength={100} required defaultValue={mode === 'related' ? query : ''} placeholder="输入作品、歌曲或艺人名称"/><button type="submit">查找相关记录</button><p>检索现有记录；标题相似的结果会保留为待确认候选。</p></form></div>
    {unavailable && <p role="status" className="discovery-message">本次查询未完成。请检查兴趣词，或稍后重试；已同步记录仍然保留。</p>}
    {recommendation && <section aria-label="视频推荐结果"><div className="discover-heading"><h2>{risk ? 'B站暂时限制访问' : recommendation.items.length ? '这次为你找到' : '这次暂未找到可核对的视频'}</h2><span>{recommendation.items.length} 个视频</span></div>{risk && <p role="status" className="discovery-message">本次请求遇到平台限制，已暂停检索。请10分钟后再试。现有记录和其他平台查询仍可使用。</p>}
      <div className="discovery-sources">{recommendation.sources.map(source => <span key={source.platform}>{names[source.platform]} · {source.status === 'ok' ? '有已同步依据' : '资料存在缺口'}</span>)}</div>
      {!recommendation.exclusion_coverage.cache_ready && <p className="discovery-message">B站历史或收藏尚未完成同步，目前只能排除已有记录和明确反馈，无法保证所有视频都未看过。</p>}
      <div className="discovery-grid">{recommendation.items.map(item => <article className="discovery-card" key={item.content_id}><div className="discovery-badges"><span>{String(item.rank).padStart(2, '0')}</span>{item.exploration && <span>探索方向</span>}</div><h3><a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a></h3><p>{item.uploader ?? 'UP主信息未提供'}{item.published_at ? ' · ' + new Date(item.published_at).toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai'}) : ''}</p>{item.reasons.map((reason, index) => <p className="discovery-reason" key={index}>{names[reason.source]} · {reason.text}</p>)}</article>)}</div>
      {recommendation.items.length > 0 && <p className="discovery-footnote">排除范围限于平台可见窗口中的已同步记录与明确反馈，未收录的观看可能遗漏。推荐依据是平台记录和本次偏好，不把时长或收藏当作喜欢程度。可在ChatGPT里明确反馈“已看过”或“不喜欢”，供下次推荐排除。</p>}</section>}
    {related && <section aria-label="作品关联结果"><div className="discover-heading"><h2>与“{related.query}”相关的记录</h2><span>{related.items.length} 条</span></div><p className="discovery-message">{related.items.length ? '以下是缓存中的关联候选；跨平台标题、专辑或艺人匹配仍待确认。' : '当前已同步缓存中没有匹配记录；这不代表平台上不存在相关内容。'}</p><div className="discovery-grid">{related.items.map(item => <article className="discovery-card" key={item.work_ref}><div className="discovery-badges"><span>{names[item.platform]}</span><span>{item.confirmed ? '同一平台条目' : '关联候选 · 待确认'}</span></div><h3>{item.title}</h3>{item.artists && <p>{item.artists.join(' / ')}</p>}{item.album && <p>专辑 · {item.album}</p>}<p className="discovery-footnote">{item.work_ref}</p></article>)}</div>{related.has_more && <p className="discovery-footnote">还有匹配结果，请用更具体的名称缩小范围。</p>}</section>}
    <footer><span>PERSONAL MEDIA ASSISTANT</span><span>依据真实记录，保留未知。</span></footer>
  </main>;
}
