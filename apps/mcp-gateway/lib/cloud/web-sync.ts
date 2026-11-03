import { z } from 'zod';
import { MediaService, type CloudEnv } from './service.ts';
import { AppError } from './security.ts';
export const webSyncSchema = z.object({ platform: z.enum(['steam', 'bilibili', 'netease']), dataset: z.enum(['owned_games', 'recent_games', 'history', 'favorites', 'favorite_folders', 'user_record_all', 'user_record_week', 'recent_plays','playlists','playlist_tracks','listening_stats']) }).strict();
export async function syncFromWeb(request: Request, userId: string | null, config: CloudEnv, fetcher: typeof fetch = fetch) {
  if (!userId) throw new AppError('AUTH_REQUIRED', 401);
  if (request.method !== 'POST' || request.headers.get('origin') !== new URL(request.url).origin) throw new AppError('ORIGIN_DENIED', 403);
  if (Number(request.headers.get('content-length') ?? 0) > 2048) throw new AppError('BODY_TOO_LARGE', 413);
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new AppError('INVALID_CONTENT_TYPE', 415);
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 2048) { await reader.cancel(); throw new AppError('BODY_TOO_LARGE', 413); } chunks.push(result.value); } }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new AppError('INVALID_ARGUMENTS');
  const input = webSyncSchema.parse(Object.fromEntries(form));
  const service = new MediaService(config, fetcher); await service.store.owner(userId);
  return { platform: input.platform, dataset: input.dataset, ...await service.sync(input) };
}
