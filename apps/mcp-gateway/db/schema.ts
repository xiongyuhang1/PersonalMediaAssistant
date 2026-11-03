import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const meta = sqliteTable('pma_meta', { key: text('key').primaryKey(), value: text('value').notNull() });
export const records = sqliteTable('media_records', {
  platform: text('platform').notNull(), dataset: text('dataset').notNull(), id: text('id').notNull(),
  contentId: text('content_id').notNull(), title: text('title').notNull(), sourceTime: text('source_time'),
  collectedAt: text('collected_at').notNull(), payload: text('payload').notNull(), generation: text('generation').notNull(),
}, t => [primaryKey({ columns: [t.platform, t.dataset, t.id] }), index('media_source_time').on(t.platform, t.dataset, t.sourceTime)]);
export const syncState = sqliteTable('platform_sync_state', {
  platform: text('platform').notNull(), dataset: text('dataset').notNull(), cursor: text('cursor'), generation: text('generation'),
  state: text('state').notNull(), lastAttempt: text('last_attempt'), lastSuccess: text('last_success'), errorCode: text('error_code'), coverageNote: text('coverage_note'),
}, t => [primaryKey({ columns: [t.platform, t.dataset] })]);
export const ingestBatches = sqliteTable('collector_batches', {
  deviceId: text('device_id').notNull(), batchId: text('batch_id').notNull(), digest: text('digest').notNull(), receivedAt: text('received_at').notNull(),
}, t => [primaryKey({ columns: [t.deviceId, t.batchId] })]);
export const feedback = sqliteTable('media_feedback', {
  requestId: text('request_id').primaryKey(), digest: text('digest').notNull(), platform: text('platform').notNull(), contentId: text('content_id').notNull(),
  feedback: text('feedback').notNull(), reason: text('reason'), createdAt: text('created_at').notNull(),
});
export const platformControls = sqliteTable('platform_controls', {
  platform: text('platform').primaryKey(), syncPaused: integer('sync_paused').notNull().default(0),
  syncEpoch: text('sync_epoch').notNull(), updatedAt: text('updated_at').notNull(),
});
export const deletions = sqliteTable('data_deletions', {
  id: text('id').primaryKey(), scope: text('scope').notNull(), deletedAt: text('deleted_at').notNull(),
});
export const steamPlaytimeSamples = sqliteTable('steam_playtime_samples', {
  day: text('day').notNull(), contentId: text('content_id').notNull(), title: text('title').notNull(),
  playtimeMinutes: integer('playtime_minutes').notNull(), capturedAt: text('captured_at').notNull(),
}, t => [primaryKey({ columns: [t.day, t.contentId] }), index('steam_sample_content_time').on(t.contentId, t.capturedAt)]);
