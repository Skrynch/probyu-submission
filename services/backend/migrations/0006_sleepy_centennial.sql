CREATE SCHEMA "research";
--> statement-breakpoint
CREATE TABLE "research"."answer_delivery_events" (
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"answer_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_delivery_events_answer_run_id_sequence_pk" PRIMARY KEY("answer_run_id","sequence"),
	CONSTRAINT "answer_delivery_events_sequence_check" CHECK (sequence > 0),
	CONSTRAINT "answer_delivery_events_type_check" CHECK (event_type = ANY (ARRAY['QUESTION_ACCEPTED','ANSWER_APPROVED','ANSWER_COMPLETED','TERMINAL']))
);
--> statement-breakpoint
ALTER TABLE "research"."answer_delivery_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."answer_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"input_ciphertext" text,
	"input_hash" text,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"safety_action" text,
	"failure_code" text,
	"access_epoch" integer NOT NULL,
	"child_access_epoch" integer NOT NULL,
	"session_privilege_epoch" integer NOT NULL,
	"policy_version" text NOT NULL,
	"kill_epoch" integer NOT NULL,
	"adapter_version" text NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "answer_runs_family_child_key_unique" UNIQUE("family_id","child_id","idempotency_key"),
	CONSTRAINT "answer_runs_scope_unique" UNIQUE("family_id","child_id","id"),
	CONSTRAINT "answer_runs_hashes_check" CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
      AND (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$')
    ),
	CONSTRAINT "answer_runs_epoch_check" CHECK (
      access_epoch > 0 AND child_access_epoch > 0 AND session_privilege_epoch > 0
      AND kill_epoch > 0 AND fence >= 0
    ),
	CONSTRAINT "answer_runs_status_check" CHECK (status = ANY (ARRAY[
      'RECEIVED','INPUT_APPROVED','QUEUED','GENERATING','OUTPUT_VALIDATING',
      'APPROVED','DELIVERING','COMPLETED','DENIED','FAILED_SAFE','CANCELLED'
    ])),
	CONSTRAINT "answer_runs_safety_action_check" CHECK (
      safety_action IS NULL OR safety_action = ANY (ARRAY[
        'ALLOW','SAFE_TRANSFORM','PARENT_GATE','SAFETY_RESPONSE','BLOCK'
      ])
    )
);
--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."approved_answer_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"answer_run_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"content_hash" text NOT NULL,
	"schema_version" text NOT NULL,
	"output_decision" text NOT NULL,
	"age_band" text NOT NULL,
	"policy_version" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approved_answer_artifacts_answer_run_unique" UNIQUE("answer_run_id"),
	CONSTRAINT "approved_answer_artifacts_scope_unique" UNIQUE("family_id","child_id","id"),
	CONSTRAINT "approved_answer_artifacts_content_hash_check" CHECK (content_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "approved_answer_artifacts_decision_check" CHECK (output_decision = 'ALLOW'),
	CONSTRAINT "approved_answer_artifacts_age_check" CHECK (age_band = ANY (ARRAY['8_10','11_12','13_14']))
);
--> statement-breakpoint
ALTER TABLE "research"."approved_answer_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."challenge_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"answer_run_id" uuid NOT NULL,
	"challenge_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "challenge_offers_answer_run_unique" UNIQUE("answer_run_id"),
	CONSTRAINT "challenge_offers_scope_unique" UNIQUE("family_id","child_id","id")
);
--> statement-breakpoint
ALTER TABLE "research"."challenge_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."challenge_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"answer_run_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"challenge_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_runs_offer_unique" UNIQUE("offer_id"),
	CONSTRAINT "challenge_runs_scope_unique" UNIQUE("family_id","child_id","id"),
	CONSTRAINT "challenge_runs_step_check" CHECK (current_step >= 0),
	CONSTRAINT "challenge_runs_status_check" CHECK (status = ANY (ARRAY['IN_PROGRESS','DECLINED','ABANDONED','BLOCKED_BY_POLICY']))
);
--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."challenge_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"materials" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"age_bands" jsonb NOT NULL,
	"risk_class" text NOT NULL,
	"supervision_requirement" text NOT NULL,
	"origin" text NOT NULL,
	"distribution_scope" text NOT NULL,
	"status" text NOT NULL,
	"policy_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "challenge_versions_key_version_unique" UNIQUE("key","version"),
	CONSTRAINT "challenge_versions_version_check" CHECK (version > 0),
	CONSTRAINT "challenge_versions_hash_check" CHECK (content_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "challenge_versions_kind_check" CHECK (kind = ANY (ARRAY['MICRO_PROBE','EXPERIENCE','PROJECT'])),
	CONSTRAINT "challenge_versions_curated_check" CHECK (origin='CURATED' AND distribution_scope='CATALOG' AND status='PUBLISHED' AND risk_class='MINIMAL_RISK' AND supervision_requirement='NONE'),
	CONSTRAINT "challenge_versions_duration_check" CHECK (duration_minutes BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "research"."command_receipts" (
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"command_key" uuid NOT NULL,
	"action_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_family_id_child_id_command_key_pk" PRIMARY KEY("family_id","child_id","command_key"),
	CONSTRAINT "research_command_receipts_hash_check" CHECK (action_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "research"."command_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"answer_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_outbox_answer_event_unique" UNIQUE("answer_run_id","event_type"),
	CONSTRAINT "research_outbox_state_check" CHECK (state = ANY (ARRAY['PENDING','PROCESSING','PROCESSED','DEAD']))
);
--> statement-breakpoint
ALTER TABLE "research"."outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research"."policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"kill_epoch" integer DEFAULT 1 NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research"."answer_delivery_events" ADD CONSTRAINT "answer_delivery_events_run_scope_fkey" FOREIGN KEY ("family_id","child_id","answer_run_id") REFERENCES "research"."answer_runs"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_delivery_events" ADD CONSTRAINT "answer_delivery_events_artifact_scope_fkey" FOREIGN KEY ("family_id","child_id","artifact_id") REFERENCES "research"."approved_answer_artifacts"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ADD CONSTRAINT "answer_runs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "family"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ADD CONSTRAINT "answer_runs_family_child_fkey" FOREIGN KEY ("family_id","child_id") REFERENCES "family"."children"("family_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ADD CONSTRAINT "answer_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "identity"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ADD CONSTRAINT "answer_runs_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "identity"."registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."answer_runs" ADD CONSTRAINT "answer_runs_policy_version_fkey" FOREIGN KEY ("policy_version") REFERENCES "research"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."approved_answer_artifacts" ADD CONSTRAINT "approved_answer_artifacts_run_scope_fkey" FOREIGN KEY ("family_id","child_id","answer_run_id") REFERENCES "research"."answer_runs"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."approved_answer_artifacts" ADD CONSTRAINT "approved_answer_artifacts_policy_fkey" FOREIGN KEY ("policy_version") REFERENCES "research"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_offers" ADD CONSTRAINT "challenge_offers_run_scope_fkey" FOREIGN KEY ("family_id","child_id","answer_run_id") REFERENCES "research"."answer_runs"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_offers" ADD CONSTRAINT "challenge_offers_version_fkey" FOREIGN KEY ("challenge_version_id") REFERENCES "research"."challenge_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_answer_scope_fkey" FOREIGN KEY ("family_id","child_id","answer_run_id") REFERENCES "research"."answer_runs"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_offer_scope_fkey" FOREIGN KEY ("family_id","child_id","offer_id") REFERENCES "research"."challenge_offers"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_runs" ADD CONSTRAINT "challenge_runs_version_fkey" FOREIGN KEY ("challenge_version_id") REFERENCES "research"."challenge_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."challenge_versions" ADD CONSTRAINT "challenge_versions_policy_fkey" FOREIGN KEY ("policy_version") REFERENCES "research"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."command_receipts" ADD CONSTRAINT "research_command_receipts_child_scope_fkey" FOREIGN KEY ("family_id","child_id") REFERENCES "family"."children"("family_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research"."outbox" ADD CONSTRAINT "research_outbox_answer_scope_fkey" FOREIGN KEY ("family_id","child_id","answer_run_id") REFERENCES "research"."answer_runs"("family_id","child_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_runs_queue_idx" ON "research"."answer_runs" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."answer_delivery_events" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."answer_runs" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."approved_answer_artifacts" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."challenge_offers" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."challenge_runs" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."command_receipts" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "research"."outbox" AS PERMISSIVE FOR ALL TO "probyu_family_runtime" USING (family_id::text = current_setting('app.family_id', true)) WITH CHECK (family_id::text = current_setting('app.family_id', true));
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='probyu_research_worker') THEN
    CREATE ROLE probyu_research_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA research TO probyu_family_runtime, probyu_research_worker;
GRANT SELECT ON research.policy_versions, research.challenge_versions TO probyu_family_runtime;
GRANT SELECT, INSERT, UPDATE ON
  research.answer_runs,
  research.approved_answer_artifacts,
  research.answer_delivery_events,
  research.challenge_offers,
  research.challenge_runs,
  research.command_receipts,
  research.outbox
TO probyu_family_runtime;
REVOKE DELETE ON ALL TABLES IN SCHEMA research FROM probyu_family_runtime;
GRANT SELECT, UPDATE ON research.answer_runs, research.outbox TO probyu_research_worker;
--> statement-breakpoint
ALTER TABLE research.answer_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE research.approved_answer_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE research.answer_delivery_events FORCE ROW LEVEL SECURITY;
ALTER TABLE research.challenge_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE research.challenge_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE research.command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE research.outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY worker_claim_answer ON research.answer_runs
  FOR SELECT TO probyu_research_worker USING (true);
CREATE POLICY worker_update_answer ON research.answer_runs
  FOR UPDATE TO probyu_research_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_claim_outbox ON research.outbox
  FOR SELECT TO probyu_research_worker USING (true);
CREATE POLICY worker_update_outbox ON research.outbox
  FOR UPDATE TO probyu_research_worker USING (true) WITH CHECK (true);
