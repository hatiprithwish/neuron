CREATE TABLE `media_objects` (
	`id` integer PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UNQ_media_objects_public_id` ON `media_objects` (`public_id`);--> statement-breakpoint
CREATE INDEX `IDX_media_objects_user_id` ON `media_objects` (`user_id`) WHERE "media_objects"."deleted_at" is null;