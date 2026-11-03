CREATE TABLE `data_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`deleted_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_controls` (
	`platform` text PRIMARY KEY NOT NULL,
	`sync_paused` integer DEFAULT 0 NOT NULL,
	`sync_epoch` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `steam_playtime_samples` (
	`day` text NOT NULL,
	`content_id` text NOT NULL,
	`title` text NOT NULL,
	`playtime_minutes` integer NOT NULL,
	`captured_at` text NOT NULL,
	PRIMARY KEY(`day`, `content_id`)
);
--> statement-breakpoint
CREATE INDEX `steam_sample_content_time` ON `steam_playtime_samples` (`content_id`,`captured_at`);