import { z } from 'zod';
export const platforms = ['steam', 'bilibili', 'netease', 'dandanplay'] as const;
export const platformSchema = z.enum(platforms);
export type Platform = z.infer<typeof platformSchema>;
export const datasetSchema = z.enum(['owned_games', 'recent_games', 'achievements', 'related_works', 'history', 'favorite_folders', 'favorites', 'likes', 'coins', 'watch_later', 'followings', 'subtitles', 'playlists', 'playlist_tracks', 'listening_stats', 'user_record_all', 'user_record_week', 'recent_plays', 'watchlist', 'episodes', 'search_results']);
export type Dataset = z.infer<typeof datasetSchema>;
const id = z.string().min(1).max(160);
const date = z.iso.datetime({ offset: true });
export const recordSchema = z.object({
  id, content_id: id, platform: platformSchema, dataset: datasetSchema,
  title: z.string().min(1).max(600),
  record_kind: z.enum(['library_snapshot', 'collection_state', 'interaction_state', 'last_watch_observation', 'last_play_observation', 'recent_play_list_item', 'lifetime_ranking', 'period_statistic', 'completion_assertion', 'media_candidate', 'metadata_snapshot']),
  collected_at: date,
  source_time: date.nullable().optional(),
  source_time_semantics: z.enum(['last_watch', 'last_play', 'collection_time', 'like_time', 'coin_time', 'recent_list_time_unverified', 'unknown']).optional(),
  interaction: z.enum(['like','coin']).optional(), coins_given: z.number().int().min(1).max(2).optional(), source_order: z.number().int().positive().optional(),
  url: z.url().max(2048).optional(),
  uploader_id: z.string().max(64).optional(), uploader_name: z.string().max(160).optional(),
  category_id: z.string().max(64).optional(), content_types: z.array(z.string().max(32)).max(12).optional(),
  published_at: date.optional(), playtime_minutes: z.number().nonnegative().optional(), recent_playtime_minutes: z.number().nonnegative().optional(),
  description: z.string().max(1200).optional(), tags: z.array(z.string().max(80)).max(20).optional(),
  quality: z.object({ views: z.number().nonnegative().optional(), likes: z.number().nonnegative().optional(), coins: z.number().nonnegative().optional(), favorites: z.number().nonnegative().optional() }).strict().optional(),
  play_count: z.number().nonnegative().optional(), rank_score: z.number().finite().optional(), rank: z.number().int().positive().optional(),
  artists: z.array(z.string().max(160)).max(30).optional(), album: z.string().max(300).optional(), duration_ms: z.number().nonnegative().optional(),
  album_id: z.string().regex(/^\d{1,20}$/).optional(), artist_ids: z.array(z.string().regex(/^\d{1,20}$/)).max(30).optional(),
  official_soundtrack_of:z.string().regex(/^\d{1,10}$/).optional(),evidence_urls:z.array(z.url().max(2048)).max(5).optional(),
  playlist_owner: z.enum(['created', 'subscribed', 'unknown']).optional(), track_count: z.number().int().nonnegative().optional(),
  achievements: z.array(z.object({ api_name:z.string().min(1).max(200),name:z.string().max(300),hidden:z.boolean(),unlocked:z.boolean(),unlocked_at:date.nullable(),description:z.string().max(1200).optional() }).strict()).max(2000).optional(),
  achievement_summary:z.object({total:z.number().int().nonnegative(),unlocked:z.number().int().nonnegative(),completion_percent:z.number().min(0).max(100).nullable(),all_unlocked:z.boolean().nullable(),state:z.enum(['available','not_applicable'])}).strict().optional(),
  listening_statistic:z.object({period:z.enum(['week','month','total','annual']),start_at:date.optional(),end_at:date.optional(),duration_raw:z.number().nonnegative().optional(),duration_unit:z.enum(['seconds','minutes','milliseconds','unknown']),unit_basis:z.enum(['verified','inferred_user_accepted','unknown']).optional(),duration_minutes:z.number().nonnegative().optional(),duration_hours:z.number().nonnegative().optional(),listen_days:z.number().int().nonnegative().optional(),year:z.number().int().min(2000).max(2200).optional(),play_num_raw:z.number().nonnegative().optional(),days:z.array(z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),duration_raw:z.number().nonnegative(),podcast_duration_raw:z.number().nonnegative().optional(),audiobook_duration_raw:z.number().nonnegative().optional(),limit_reached:z.boolean().optional()}).strict()).max(32).optional()}).strict().optional(),
  subtitle_language:z.string().max(40).optional(),subtitle_request_key:z.string().max(160).optional(),subtitle_status:z.enum(['available','unavailable']).optional(),subtitle_chunk:z.number().int().nonnegative().optional(),
  transcript:z.array(z.object({start_seconds:z.number().nonnegative(),end_seconds:z.number().nonnegative(),text:z.string().max(1200)}).strict()).max(50).optional(),
  parent_id: id.optional(), episode_id: id.optional(), following: z.boolean().optional(),
  favorite_status: z.number().int().optional(), episodes_watched: z.number().int().nonnegative().optional(),
  completion_state: z.enum(['unknown', 'not_completed', 'completed', 'abandoned', 'following']).optional(),
  completion_basis: z.enum(['explicit_source_status', 'explicit_user_statement', 'unknown']).optional(),
  all_episodes_completed: z.boolean().optional(), last_watched_at: date.nullable().optional(),
  last_local_play_at: date.optional(), resume_position_raw: z.number().nonnegative().optional(), resume_unit: z.literal('unknown').optional(),
  user_rating: z.number().gt(0).max(10).nullable().optional(), user_rating_state: z.enum(['rated', 'unrated', 'unknown']).optional(),
  community_rating: z.number().min(0).max(10).optional(), user_comment: z.string().max(1000).optional(), user_comment_truncated: z.boolean().optional(),
}).strict().superRefine((r, ctx) => {
  if ((r.achievements || r.achievement_summary) && (r.platform!=='steam'||r.dataset!=='achievements'||r.record_kind!=='metadata_snapshot')) ctx.addIssue({code:'custom',message:'Steam achievement scope required'});
  if (r.listening_statistic && (r.platform!=='netease'||r.dataset!=='listening_stats'||r.record_kind!=='metadata_snapshot')) ctx.addIssue({code:'custom',message:'Listening statistic scope required'});
  if ((r.transcript || r.subtitle_status || r.subtitle_request_key) && (r.platform!=='bilibili'||r.dataset!=='subtitles'||r.record_kind!=='metadata_snapshot')) ctx.addIssue({code:'custom',message:'Subtitle scope required'});
  if (r.official_soundtrack_of && (r.platform!=='steam'||r.dataset!=='related_works'||!r.evidence_urls?.length)) ctx.addIssue({code:'custom',message:'Official soundtrack evidence required'});
  if (r.all_episodes_completed && (r.completion_state !== 'completed' || !r.completion_basis || r.completion_basis === 'unknown')) ctx.addIssue({ code: 'custom', message: 'Completion requires explicit evidence' });
  if (r.user_rating_state === 'rated' && !(typeof r.user_rating === 'number' && r.user_rating > 0)) ctx.addIssue({ code: 'custom', message: 'Rated requires a positive personal score' });
  if (r.user_rating_state === 'unrated' && r.user_rating != null) ctx.addIssue({ code: 'custom', message: 'Unrated cannot carry a personal score' });
  if (r.platform === 'dandanplay' && r.dataset === 'watchlist' && r.favorite_status !== undefined && [0, 1, 2].includes(r.favorite_status)) {
    const expected = ['not_completed', 'completed', 'abandoned'][r.favorite_status];
    if (r.completion_state !== expected || r.completion_basis !== 'explicit_source_status' || r.all_episodes_completed !== (r.favorite_status === 1)) ctx.addIssue({ code: 'custom', message: 'FavoriteStatus must preserve explicit source status' });
  }
});
export type MediaRecord = z.infer<typeof recordSchema>;
export const querySchema = z.object({
  platform: platformSchema.optional(), dataset: datasetSchema.optional(),
  keyword: z.string().max(200).optional(), uploader_id: z.string().max(64).optional(), category_id: z.string().max(64).optional(),
  content_type: z.string().max(32).optional(), after: date.optional(), before: date.optional(),
  parent_id: z.string().max(160).optional(), content_id: z.string().max(160).optional(),
  following: z.boolean().optional(), completion_state: z.enum(['unknown', 'not_completed', 'completed', 'abandoned', 'following']).optional(),
  user_rating: z.number().gt(0).max(10).optional(), rating_state: z.enum(['rated', 'unrated', 'unknown']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1800).optional(),
}).strict().refine(q => !q.after || !q.before || Date.parse(q.after) < Date.parse(q.before), 'Invalid date range');
export type Query = z.infer<typeof querySchema>;
export const syncSchema = z.object({ platform: platformSchema, dataset: datasetSchema, max_pages: z.number().int().min(1).max(10).default(3), restart_cursor: z.boolean().default(false), app_id:z.string().regex(/^[1-9]\d{0,9}$/).optional(), candidate_app_ids:z.array(z.string().regex(/^[1-9]\d{0,9}$/)).min(1).max(3).optional(), request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional() }).strict();
export const ingestSchema = z.object({
  schema_version: z.literal('1.0'), device_id: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/),
  batch_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), items: z.array(recordSchema).min(1).max(500),
}).strict().superRefine((batch, ctx) => { if (batch.items.some(item => item.platform !== 'dandanplay' || !['watchlist', 'episodes', 'history'].includes(item.dataset))) ctx.addIssue({ code: 'custom', message: 'DandanPlay records only' }); });
export const feedbackSchema = z.object({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), platform: platformSchema, content_id: id, feedback: z.enum(['like', 'dislike', 'seen', 'saved', 'inaccurate']), reason: z.string().max(1000).optional() }).strict();
export interface Page { items: MediaRecord[]; next_cursor?: unknown; snapshot: boolean; coverage_note?: string; }
export interface Adapter { platform: Platform; configured: boolean; datasets: Dataset[]; page(dataset: Dataset, cursor?: unknown): Promise<Page>; }
