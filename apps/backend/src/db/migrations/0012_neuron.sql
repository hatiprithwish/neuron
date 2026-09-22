CREATE TABLE `daily_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`user_id` text NOT NULL,
	`local_date` text NOT NULL,
	`tz` text NOT NULL,
	`content_json` text NOT NULL,
	`content_text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UNQ_daily_logs_public_id` ON `daily_logs` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `UNQ_daily_logs_user_id_local_date` ON `daily_logs` (`user_id`,`local_date`) WHERE "daily_logs"."deleted_at" is null;