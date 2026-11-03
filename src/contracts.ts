import { z } from 'zod';
export const platforms = ['steam', 'bilibili', 'netease', 'dandanplay'] as const;
export const platformSchema = z.enum(platforms);
export type Platform = z.infer<typeof platformSchema>;
export const datasetSchema = z.enum(['owned_games', 'recent_games', 'history', 'favorite_folders', 'favorites', 'user_record_all', 'user_record_week', 'recent_plays', 'watchlist', 'episodes', 'search_results']);
export type Dataset = z.infer<typeof datasetSchema>;
const id = z.string().min(1).max(160);
const date = z.iso.datetime({ offset: true });
export const recordSchema = z.object({
  id, content_id: id, platform: platformSchema, dataset: datasetSchema,
  title: z.string().min(1).max(600),
  record_kind: z.enum(['library_snapshot', 'collection_state', 'last_watch_observation', 'last_play_observation', 'recent_play_list_item', 'lifetime_ranking', 'period_statistic', 'completion_assertion', 'media_candidate']),
  collected_at: date,
  source_time: date.nullable().optional(),
  source_time_semantics: z.enum(['last_watch', 'last_play', 'collection_time', 'recent_list_time_unverified', 'unknown']).optional(),
  url: z.url().max(2048).optional(),
  uploader_id: z.string().max(64).optional(), uploader_name: z.string().max(160).optional(),
  category_id: z.string().max(64).optional(), content_types: z.array(z.string().max(32)).max(12).optional(),
  published_at: date.optional(), playtime_minutes: z.number().nonnegative().optional(), recent_playtime_minutes: z.number().nonnegative().optional(),
  play_count: z.number().nonnegative().optional(), rank_score: z.number().finite().optional(), rank: z.number().int().positive().optional(),
  artists: z.array(z.string().max(160)).max(30).optional(), album: z.string().max(300).optional(), duration_ms: z.number().nonnegative().optional(),
  parent_id: id.optional(), episode_id: id.optional(), following: z.boolean().optional(),
  completion_state: z.enum(['unknown', 'completed', 'abandoned', 'following']).optional(),
  completion_basis: z.enum(['explicit_source_status', 'explicit_user_statement', 'unknown']).optional(),
  all_episodes_completed: z.boolean().optional(), last_watched_at: date.nullable().optional(),
  user_rating: z.number().min(0).max(10).optional(), community_rating: z.number().min(0).max(10).optional(),
}).strict().superRefine((r, ctx) => {
  if (r.all_episodes_completed && (r.completion_state !== 'completed' || !r.completion_basis || r.completion_basis === 'unknown')) ctx.addIssue({ code: 'custom', message: 'Completion requires explicit evidence' });
});
export type MediaRecord = z.infer<typeof recordSchema>;
export const querySchema = z.object({
  platform: platformSchema.optional(), dataset: datasetSchema.optional(),
  keyword: z.string().max(200).optional(), uploader_id: z.string().max(64).optional(), category_id: z.string().max(64).optional(),
  content_type: z.string().max(32).optional(), after: date.optional(), before: date.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1800).optional(),
}).strict().refine(q => !q.after || !q.before || Date.parse(q.after) < Date.parse(q.before), 'Invalid date range');
export type Query = z.infer<typeof querySchema>;
export const syncSchema = z.object({ platform: platformSchema, dataset: datasetSchema, max_pages: z.number().int().min(1).max(10).default(3), restart_cursor: z.boolean().default(false), request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional() }).strict();
export const ingestSchema = z.object({
  schema_version: z.literal('1.0'), device_id: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/),
  batch_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), items: z.array(recordSchema).min(1).max(500),
}).strict().superRefine((batch, ctx) => { if (batch.items.some(item => item.platform !== 'dandanplay' || !['watchlist', 'episodes', 'history'].includes(item.dataset))) ctx.addIssue({ code: 'custom', message: 'DandanPlay records only' }); });
export const feedbackSchema = z.object({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), platform: platformSchema, content_id: id, feedback: z.enum(['like', 'dislike', 'seen', 'saved', 'inaccurate']), reason: z.string().max(1000).optional() }).strict();
export interface Page { items: MediaRecord[]; next_cursor?: unknown; snapshot: boolean; coverage_note?: string; }
export interface Adapter { platform: Platform; configured: boolean; datasets: Dataset[]; page(dataset: Dataset, cursor?: unknown): Promise<Page>; }
