// Read-only request/encryption subset adapted from api-enhanced and Vael-KY.
// Original public protocol constants are not user credentials. See vendor licenses.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from './security.ts';
const modulus = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7');
function pow(base: bigint, exponent: bigint, mod: bigint) { let value = 1n; for (; exponent; exponent >>= 1n, base = base * base % mod) if (exponent & 1n) value = value * base % mod; return value; }
function aes(text: string, key: string, mode: 'cbc' | 'ecb') { const cipher = createCipheriv(`aes-128-${mode}`, Buffer.from(key), mode === 'cbc' ? Buffer.from('0102030405060708') : Buffer.alloc(0)); return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); }
export function weapi(payload: Record<string, unknown>, key = randomBytes(12).toString('base64').slice(0, 16)) {
  if (key.length !== 16) throw new AppError('INVALID_CRYPTO_KEY');
  const first = aes(JSON.stringify(payload), '0CoJUm6Qyw8W8jud', 'cbc').toString('base64');
  return { params: aes(first, key, 'cbc').toString('base64'), encSecKey: pow(BigInt(`0x${Buffer.from([...key].reverse().join('')).toString('hex')}`), 65537n, modulus).toString(16).padStart(256, '0') };
}
export function eapi(path: string, payload: Record<string, unknown>) {
  const text = JSON.stringify(payload);
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex');
  return { params: aes(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, 'e82ckenh8dichen8', 'ecb').toString('hex').toUpperCase() };
}
const routes = {
  '/user/record': ['/api/v1/play/record', 'weapi'],
  '/record/recent/song': ['/api/play-record/song/list', 'weapi'],
  '/likelist': ['/api/song/like/get', 'eapi'],
  '/song/detail': ['/api/v3/song/detail', 'weapi'],
  '/user/playlist': ['/api/user/playlist', 'weapi'],
  '/playlist/detail': ['/api/v6/playlist/detail', 'eapi'],
  '/lyric': ['/api/song/lyric', 'eapi'],
  '/listen/data/realtime/report': ['/api/content/activity/listen/data/realtime/report', 'eapi'],
  '/listen/data/song/play/rank': ['/api/content/activity/listen/data/song/play/rank', 'eapi'],
  '/listen/data/total': ['/api/content/activity/listen/data/total', 'eapi'],
  '/listen/data/year/report': ['/api/content/activity/listen/data/year/report', 'eapi'],
  '/listen/data/today/song': ['/api/content/activity/listen/data/today/song/play/rank', 'eapi'],
} as const;
export async function neteaseRequest(route: keyof typeof routes, input: Record<string, unknown>, cookie: string, fetcher: typeof fetch = fetch) {
  const [path, mode] = routes[route];
  const jar = Object.fromEntries(cookie.split(';').map(part => { const i = part.indexOf('='); return i > 0 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : ['', '']; }).filter(([key]) => key));
  if (!jar.MUSIC_U) throw new AppError('AUTH_REQUIRED', 409);
  const data: Record<string, unknown> = { ...input, e_r: false };
  if (route === '/song/detail') { const ids = String(input.ids).split(','); if (ids.some(id => !/^\d{1,20}$/.test(id))) throw new AppError('INVALID_SONG_ID'); data.c = '[' + ids.map(id => `{"id":${id}}`).join(',') + ']'; delete data.ids; }
  let body: Record<string, string>; let destination: string;
  if (mode === 'weapi') { data.csrf_token = jar.__csrf ?? ''; body = weapi(data); destination = `https://music.163.com/weapi/${path.slice(5)}`; }
  else {
    data.header = { os: jar.os ?? 'pc', appver: jar.appver ?? '3.0.18.203152', __csrf: jar.__csrf ?? '', requestId: randomUUID(), MUSIC_U: jar.MUSIC_U };
    body = eapi(path, data); destination = `https://interfacepc.music.163.com/eapi/${path.slice(5)}`;
  }
  const response = await fetcher(destination, { method: 'POST', headers: { Cookie: cookie, Referer: 'https://music.163.com/', Origin: 'https://music.163.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'manual', signal: AbortSignal.timeout(12000) });
  if (response.status >= 300 && response.status < 400) throw new AppError('UPSTREAM_REDIRECT_BLOCKED', 502);
  if (!response.ok) throw new AppError(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE', 502);
  return response.json();
}
