import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export class AppError extends Error {
  code: string; http: number;
  constructor(code: string, http = 400, public upstream?: import('./bilibili-transport.ts').BiliDiagnostic) { super(code); this.code = code; this.http = http; }
}
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function authorized(header: string | undefined, expected: string | undefined) {
  if (!expected || expected.length < 32 || !header?.startsWith('Bearer ') || header.length > 300) return false;
  return timingSafeEqual(Buffer.from(hash(header.slice(7))), Buffer.from(hash(expected)));
}
export function signCursor(value: unknown, secret: string) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function readCursor(cursor: string, secret: string) {
  try {
    const [data, signature, extra] = cursor.split('.');
    const expected = createHmac('sha256', secret).update(data).digest('base64url');
    if (extra || !signature || !authorized(`Bearer ${signature}`, expected)) throw new Error();
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch { throw new AppError('INVALID_CURSOR'); }
}
export function safeError(error: unknown) {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', 500);
}
