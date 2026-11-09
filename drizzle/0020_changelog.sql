ALTER TABLE "sessions" ADD COLUMN "changelog_shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;