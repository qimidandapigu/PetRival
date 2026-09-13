CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `score_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`pet_id` text NOT NULL,
	`pet_name` text NOT NULL,
	`delta` integer NOT NULL,
	`total` integer NOT NULL,
	`rank_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ledger_match_pet` ON `score_ledger` (`match_id`,`pet_id`);--> statement-breakpoint
CREATE INDEX `idx_ledger_pet_time` ON `score_ledger` (`pet_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `levels` (
	`id` text PRIMARY KEY NOT NULL,
	`pet_id` text NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`training` integer NOT NULL,
	`created_at` integer NOT NULL,
	`winner` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `arena_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`token` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner` text,
	`score` integer DEFAULT 0 NOT NULL,
	`rank_ms` integer DEFAULT 0 NOT NULL,
	`played` integer DEFAULT 0 NOT NULL,
	`bot` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pets_owner` ON `pets` (`owner`);--> statement-breakpoint
CREATE INDEX `idx_pets_ranking` ON `pets` (`bot`,`score`,`rank_ms`);--> statement-breakpoint
CREATE TABLE `practices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`data` text NOT NULL
);
