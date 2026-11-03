import { randomUUID } from 'node:crypto'
import { Config, parseCookie } from './config.js'
import { keyFromUrl, signWbi } from './wbi.js'

export type FetchLike = typeof fetch

export class BiliError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message)
    this.name = 'BiliError'
  }
}

/** Known bilibili error codes → actionable hints for the AI / user */
const CODE_HINTS: Record<number, string> = {
  [-101]: '账号未登录：请在 MCP 配置中设置 BILIBILI_COOKIE（或 BILIBILI_SESSDATA）',
  [-111]: 'CSRF 校验失败：Cookie 中缺少有效的 bili_jct',
  [-352]: '风控校验失败：请设置完整的 BILIBILI_COOKIE（含 buvid3）后重试',
  [-403]: '访问权限不足（可能需要大会员或登录）',
  [-404]: '内容不存在或已被删除',
  [-412]: '请求被拦截（频率过高或风控），请稍后重试',
  62002: '稿件不可见',
  62004: '稿件审核中',
  62012: '仅 UP 主自己可见',
}

type Query = Record<string, string | number | boolean | undefined>

export interface RequestOptions {
  query?: Query
  /** sign the query with WBI */
  wbi?: boolean
  method?: 'GET' | 'POST'
  form?: Query
  headers?: Record<string, string>
  redirect?: RequestRedirect
}

const toSearch = (query: Query = {}) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

export class BiliClient {
  private wbiKeys?: { img: string; sub: string; fetchedAt: number }
  private cookie: string
  private buvidReady: Promise<void> | undefined

  constructor(
    public config: Config,
    private fetchImpl: FetchLike = fetch,
  ) {
    this.cookie = config.cookie
  }

  get loggedIn() {
    return Boolean(parseCookie(this.cookie).SESSDATA)
  }

  get csrf() {
    return parseCookie(this.cookie).bili_jct
  }

  /** Headers bilibili expects from a browser; Referer is mandatory for media CDN downloads. */
  get baseHeaders(): Record<string, string> {
    return {
      'User-Agent': this.config.userAgent,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    }
  }

  /** Search and some other APIs reject requests without a buvid3 cookie (-412/-352). */
  private ensureBuvid() {
    if (parseCookie(this.cookie).buvid3) return Promise.resolve()
    this.buvidReady ??= (async () => {
      try {
        const res = await this.fetchImpl('https://api.bilibili.com/x/frontend/finger/spi', {
          headers: this.baseHeaders,
        })
        const json: any = await res.json()
        const b3 = json?.data?.b_3
        const b4 = json?.data?.b_4
        const extra = [`buvid3=${b3 || `${randomUUID().toUpperCase()}infoc`}`]
        if (b4) extra.push(`buvid4=${b4}`)
        this.cookie = [this.cookie, ...extra].filter(Boolean).join('; ')
      } catch {
        this.cookie = [this.cookie, `buvid3=${randomUUID().toUpperCase()}infoc`]
          .filter(Boolean)
          .join('; ')
      }
    })()
    return this.buvidReady
  }

  private async getWbiKeys() {
    const ttl = 60 * 60 * 1000
    if (this.wbiKeys && Date.now() - this.wbiKeys.fetchedAt < ttl) return this.wbiKeys
    const res = await this.fetchImpl('https://api.bilibili.com/x/web-interface/nav', {
      headers: this.baseHeaders,
    })
    const json: any = await res.json()
    // nav returns code -101 when logged out but still carries wbi_img
    const img = json?.data?.wbi_img?.img_url
    const sub = json?.data?.wbi_img?.sub_url
    if (!img || !sub) throw new BiliError('获取 WBI 签名密钥失败')
    this.wbiKeys = { img: keyFromUrl(img), sub: keyFromUrl(sub), fetchedAt: Date.now() }
    return this.wbiKeys
  }

  async raw(url: string, options: RequestOptions = {}): Promise<Response> {
    await this.ensureBuvid()
    let search = toSearch(options.query)
    if (options.wbi) {
      const keys = await this.getWbiKeys()
      search = signWbi(options.query ?? {}, keys.img, keys.sub)
    }
    const fullUrl = search ? `${url}${url.includes('?') ? '&' : '?'}${search}` : url
    const headers: Record<string, string> = { ...this.baseHeaders, ...options.headers }
    // never leak account cookies to CDN / third-party hosts
    if (!/(^|\.)(bilibili\.com|b23\.tv|bili2233\.cn)$/.test(new URL(fullUrl).hostname)) {
      delete headers.Cookie
      delete headers.Origin
    }
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      redirect: options.redirect,
    }
    if (options.form) {
      init.method = 'POST'
      init.body = toSearch(options.form)
      ;(init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    const res = await this.fetchImpl(fullUrl, init)
    const isRedirect = options.redirect === 'manual' && res.status >= 300 && res.status < 400
    if (!res.ok && !isRedirect) {
      if (res.status === 412) {
        throw new BiliError(`HTTP 412：${CODE_HINTS[-412]} — ${url}`, -412)
      }
      throw new BiliError(`HTTP ${res.status} ${res.statusText} — ${url}`, res.status)
    }
    return res
  }

  /** Request a standard bilibili JSON API and unwrap `data` / `result`. */
  async json<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(url, options)
    const body: any = await res.json()
    if (body.code !== undefined && body.code !== 0) {
      // a stale WBI key yields -403/-352; refresh once and retry
      if (options.wbi && (body.code === -403 || body.code === -352) && this.wbiKeys) {
        this.wbiKeys = undefined
        const retry: any = await (await this.raw(url, options)).json()
        if (retry.code === 0) return (retry.data ?? retry.result) as T
      }
      const hint = CODE_HINTS[body.code]
      throw new BiliError(
        `B站接口错误 ${body.code}: ${body.message || body.msg || 'unknown'}${hint ? `（${hint}）` : ''}`,
        body.code,
      )
    }
    return (body.data ?? body.result ?? body) as T
  }

  async buffer(url: string, options: RequestOptions = {}) {
    const res = await this.raw(url, options)
    return new Uint8Array(await res.arrayBuffer())
  }

  requireLogin(feature: string) {
    if (!this.loggedIn) {
      throw new BiliError(
        `「${feature}」需要登录：请在 MCP 服务的环境变量中配置 BILIBILI_COOKIE 或 BILIBILI_SESSDATA`,
        -101,
      )
    }
  }

  requireWrite(feature: string) {
    this.requireLogin(feature)
    if (!this.config.allowWrite) {
      throw new BiliError(
        `「${feature}」会修改你的 B 站账号数据，默认关闭。如确需开启，请设置 BILIBILI_ALLOW_WRITE=true`,
      )
    }
    if (!this.csrf) throw new BiliError(`「${feature}」需要 Cookie 中的 bili_jct（CSRF）`, -111)
  }
}
