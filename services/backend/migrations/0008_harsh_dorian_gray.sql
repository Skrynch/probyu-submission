ALTER TABLE "research"."challenge_runs" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research"."challenge_versions" ADD COLUMN "resume_window_minutes" integer;--> statement-breakpoint
UPDATE "research"."challenge_runs" r
SET "expires_at"=GREATEST(o."expires_at",r."created_at"+interval '30 minutes')
FROM "research"."challenge_offers" o
WHERE o."id"=r."offer_id";--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_expiry_check" CHECK (expires_at > created_at);--> statement-breakpoint
ALTER TABLE "research"."challenge_versions" ADD CONSTRAINT "challenge_versions_resume_window_check" CHECK ((version = 1 AND resume_window_minutes IS NULL) OR (version > 1 AND resume_window_minutes BETWEEN duration_minutes AND 10080));
