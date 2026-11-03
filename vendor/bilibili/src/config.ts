import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Runtime configuration, read from environment variables.
 *
 * BILIBILI_COOKIE     full cookie string copied from a logged-in browser (recommended)
 * BILIBILI_SESSDATA   alternative: only the SESSDATA value
 * BILIBILI_BILI_JCT   alternative: only the bili_jct value (CSRF token, needed for write actions)
 * BILIBILI_DOWNLOAD_DIR  where downloads are saved (default ~/Downloads/bilibili)
 * BILIBILI_FFMPEG     path to ffmpeg (default "ffmpeg" on PATH) used to merge DASH audio+video
 * BILIBILI_ALLOW_WRITE  "true" to enable account write tools (watch-later add/remove)
 */
export interface Config {
  cookie: string
  csrf?: string
  downloadDir: string
  ffmpeg: string
  allowWrite: boolean
  userAgent: string
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export const parseCookie = (cookie: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return result
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  let cookie = (env.BILIBILI_COOKIE ?? '').trim()
  const parts = parseCookie(cookie)
  if (env.BILIBILI_SESSDATA && !parts.SESSDATA) {
    cookie = [cookie, `SESSDATA=${env.BILIBILI_SESSDATA.trim()}`].filter(Boolean).join('; ')
  }
  if (env.BILIBILI_BILI_JCT && !parts.bili_jct) {
    cookie = [cookie, `bili_jct=${env.BILIBILI_BILI_JCT.trim()}`].filter(Boolean).join('; ')
  }
  const csrf = parseCookie(cookie).bili_jct
  return {
    cookie,
    csrf,
    downloadDir: resolve(env.BILIBILI_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'bilibili')),
    ffmpeg: env.BILIBILI_FFMPEG || 'ffmpeg',
    allowWrite: /^(1|true|yes)$/i.test(env.BILIBILI_ALLOW_WRITE ?? ''),
    userAgent: env.BILIBILI_USER_AGENT || DEFAULT_UA,
  }
}
