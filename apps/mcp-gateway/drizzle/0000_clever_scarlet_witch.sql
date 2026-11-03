CREATE TABLE `media_feedback` (
	`request_id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`platform` text NOT NULL,
	`content_id` text NOT NULL,
	`feedback` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collector_batches` (
	`device_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`digest` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`device_id`, `batch_id`)
);
--> statement-breakpoint
CREATE TABLE `pma_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_records` (
	`platform` text NOT NULL,
	`dataset` text NOT NULL,
	`id` text NOT NULL,
	`content_id` text NOT NULL,
	`title` text NOT NULL,
	`source_time` text,
	`collected_at` text NOT NULL,
	`payload` text NOT NULL,
	`generation` text NOT NULL,
	PRIMARY KEY(`platform`, `dataset`, `id`)
);
--> statement-breakpoint
CREATE INDEX `media_source_time` ON `media_records` (`platform`,`dataset`,`source_time`);--> statement-breakpoint
CREATE TABLE `platform_sync_state` (
	`platform` text NOT NULL,
	`dataset` text NOT NULL,
	`cursor` text,
	`generation` text,
	`state` text NOT NULL,
	`last_attempt` text,
	`last_success` text,
	`error_code` text,
	`coverage_note` text,
	PRIMARY KEY(`platform`, `dataset`)
);
