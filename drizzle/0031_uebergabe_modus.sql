ALTER TABLE "sessions" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lock_return" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "unlock_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unlock_pin_hash" text;