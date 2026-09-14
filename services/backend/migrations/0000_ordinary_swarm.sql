CREATE SCHEMA "content";
--> statement-breakpoint
CREATE TABLE "content"."fixed_demo_scenarios" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"locale" text NOT NULL,
	"age_band" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fixed_demo_scenarios_id_version_pk" PRIMARY KEY("id","version")
);
