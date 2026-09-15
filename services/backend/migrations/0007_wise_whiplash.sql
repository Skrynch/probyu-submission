ALTER TABLE "research"."challenge_runs" DROP CONSTRAINT "challenge_runs_step_check";--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" DROP CONSTRAINT "challenge_runs_status_check";--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD COLUMN "row_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_step_check" CHECK (current_step >= 0 AND row_version >= 0);--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_status_check" CHECK (status = ANY (ARRAY['IN_PROGRESS','DECLINED','ABANDONED','EXPIRED','BLOCKED_BY_POLICY']));