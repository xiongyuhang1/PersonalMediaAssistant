import { createHash } from 'node:crypto'

/**
 * WBI request signing used by many bilibili web APIs (`/wbi/` paths).
 * Bilibili-Evolved runs inside the browser and lets the page do this implicitly;
 * a standalone server has to sign requests itself.
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

export const getMixinKey = (imgKey: string, subKey: string) => {
  const orig = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32)
}

/** Extract the key from a wbi image url like https://i0.hdslb.com/bfs/wbi/7cd0...077c.png */
export const keyFromUrl = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0]

export const signWbi = (
  params: Record<string, string | number | boolean | undefined>,
  imgKey: string,
  subKey: string,
  timestamp = Math.round(Date.now() / 1000),
) => {
  const mixinKey = getMixinKey(imgKey, subKey)
  const withTs: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    withTs[key] = String(value).replace(/[!'()*]/g, '')
  }
  withTs.wts = String(timestamp)
  const query = Object.keys(withTs)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(withTs[key])}`)
    .join('&')
  const wRid = createHash('md5')
    .update(query + mixinKey)
    .digest('hex')
  return `${query}&w_rid=${wRid}`
}
