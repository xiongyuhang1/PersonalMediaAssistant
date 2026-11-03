import { AppError } from './security.ts';
export async function readSameOriginForm(request: Request, userId: string | null) {
  if (!userId) throw new AppError('AUTH_REQUIRED', 401);
  if (request.method !== 'POST' || request.headers.get('origin') !== new URL(request.url).origin) throw new AppError('ORIGIN_DENIED', 403);
  if (Number(request.headers.get('content-length') ?? 0) > 4096) throw new AppError('BODY_TOO_LARGE', 413);
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new AppError('INVALID_CONTENT_TYPE', 415);
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) { await reader.cancel(); throw new AppError('BODY_TOO_LARGE', 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new AppError('INVALID_ARGUMENTS');
  return Object.fromEntries(form);
}
