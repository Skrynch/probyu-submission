CREATE SCHEMA identity;
CREATE SCHEMA family;
CREATE SCHEMA ops;
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'probyu_family_runtime') THEN CREATE ROLE probyu_family_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT USAGE ON SCHEMA identity, family, ops TO probyu_family_runtime;
CREATE TABLE identity.parents (
 id uuid PRIMARY KEY, synthetic_key text UNIQUE NOT NULL CHECK(synthetic_key IN ('aurora','comet')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
 attempts integer NOT NULL DEFAULT 0, attempt_window timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE family.families (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES identity.parents(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 access_epoch integer NOT NULL DEFAULT 1 CHECK(access_epoch>0), UNIQUE(id,owner_id)
);
CREATE TABLE family.memberships (
 family_id uuid NOT NULL REFERENCES family.families(id), parent_id uuid NOT NULL REFERENCES identity.parents(id),
 role text NOT NULL CHECK(role='OWNER'), status text NOT NULL CHECK(status='ACTIVE'),
 PRIMARY KEY(family_id,parent_id), UNIQUE(family_id),
 FOREIGN KEY(family_id,parent_id) REFERENCES family.families(id,owner_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE family.families ADD CONSTRAINT family_has_owner FOREIGN KEY(id,owner_id) REFERENCES family.memberships(family_id,parent_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE family.representatives (
 family_id uuid PRIMARY KEY REFERENCES family.families(id), parent_id uuid NOT NULL,
 method text NOT NULL CHECK(method='SYNTHETIC'), policy_version text NOT NULL,
 expires_at timestamptz NOT NULL, FOREIGN KEY(family_id,parent_id) REFERENCES family.memberships(family_id,parent_id)
);
CREATE TABLE family.children (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES family.families(id),
 nickname text NOT NULL CHECK(nickname='Исследователь'), age_band text NOT NULL CHECK(age_band IN ('8_10','11_12','13_14')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED')),
 access_epoch integer NOT NULL DEFAULT 1 CHECK(access_epoch>0), UNIQUE(family_id,id)
);
CREATE TABLE identity.registrations (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES family.families(id), parent_id uuid NOT NULL REFERENCES identity.parents(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
 privilege_epoch integer NOT NULL DEFAULT 1, UNIQUE(family_id,id)
);
CREATE TABLE identity.sessions (
 id uuid PRIMARY KEY, digest text UNIQUE NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 family_id uuid REFERENCES family.families(id), parent_id uuid REFERENCES identity.parents(id),
 registration_id uuid, child_id uuid, mode text NOT NULL CHECK(mode IN ('ANONYMOUS','PARENT','CHILD')),
 privilege_epoch integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, parent_seen timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, attempt_window timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,registration_id) REFERENCES identity.registrations(family_id,id),
 FOREIGN KEY(family_id,child_id) REFERENCES family.children(family_id,id),
 CHECK((mode='ANONYMOUS' AND family_id IS NULL AND parent_id IS NULL AND registration_id IS NULL AND child_id IS NULL)
 OR (mode='PARENT' AND family_id IS NOT NULL AND parent_id IS NOT NULL AND registration_id IS NOT NULL AND child_id IS NULL)
 OR (mode='CHILD' AND family_id IS NOT NULL AND parent_id IS NOT NULL AND registration_id IS NOT NULL AND child_id IS NOT NULL))
);
CREATE TABLE identity.proofs (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES identity.sessions(id),
 purpose text NOT NULL CHECK(purpose IN ('LOGIN','REAUTH')), synthetic_key text,
 action_hash text, code_digest text NOT NULL, expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0, consumed_at timestamptz
);
CREATE TABLE family.reauth_receipts (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES family.families(id),
 parent_id uuid NOT NULL REFERENCES identity.parents(id), session_id uuid NOT NULL REFERENCES identity.sessions(id),
 registration_id uuid NOT NULL REFERENCES identity.registrations(id), action_hash text NOT NULL,
 policy_version text NOT NULL, privilege_epoch integer NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE family.consent_documents (
 version text PRIMARY KEY, text_body text NOT NULL, history_body text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL
);
CREATE TABLE family.consent_receipts (
 id uuid PRIMARY KEY, family_id uuid NOT NULL, child_id uuid NOT NULL, parent_id uuid NOT NULL REFERENCES identity.parents(id),
 reauth_id uuid NOT NULL REFERENCES family.reauth_receipts(id), document_version text NOT NULL REFERENCES family.consent_documents(version),
 purpose text NOT NULL CHECK(purpose IN ('TEXT','HISTORY')), granted boolean NOT NULL,
 prior_id uuid REFERENCES family.consent_receipts(id), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(family_id,child_id) REFERENCES family.children(family_id,id), UNIQUE(family_id,child_id,id)
);
CREATE TABLE family.consent_projections (
 family_id uuid NOT NULL, child_id uuid NOT NULL, purpose text NOT NULL CHECK(purpose IN ('TEXT','HISTORY')),
 receipt_id uuid NOT NULL, granted boolean NOT NULL, document_version text NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(family_id,child_id,purpose),
 FOREIGN KEY(family_id,child_id,receipt_id) REFERENCES family.consent_receipts(family_id,child_id,id)
);
CREATE TABLE family.command_receipts (
 family_id uuid NOT NULL REFERENCES family.families(id), parent_id uuid NOT NULL REFERENCES identity.parents(id),
 command_key uuid NOT NULL, action_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(family_id,parent_id,command_key)
);
CREATE TABLE ops.family_outbox (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES family.families(id),
 event_type text NOT NULL, access_epoch integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSED'))
);
CREATE TABLE family.processing_authorizations (
 id uuid PRIMARY KEY, family_id uuid NOT NULL, child_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('TEXT','HISTORY')), access_epoch integer NOT NULL,
 policy_version text NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(family_id,child_id) REFERENCES family.children(family_id,id)
);
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA identity, family, ops TO probyu_family_runtime;
REVOKE UPDATE ON family.consent_receipts, family.consent_documents, family.command_receipts FROM probyu_family_runtime;
REVOKE INSERT ON family.consent_documents FROM probyu_family_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['families','memberships','representatives','children','reauth_receipts','consent_receipts','consent_projections','command_receipts','processing_authorizations'] LOOP
 EXECUTE format('ALTER TABLE family.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE family.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant ON family.%I USING (%I::text = current_setting(''app.family_id'',true)) WITH CHECK (%I::text = current_setting(''app.family_id'',true))',t,CASE WHEN t='families' THEN 'id' ELSE 'family_id' END,CASE WHEN t='families' THEN 'id' ELSE 'family_id' END);
 END LOOP;
END $$;
ALTER TABLE ops.family_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.family_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ops.family_outbox USING(family_id::text=current_setting('app.family_id',true)) WITH CHECK(family_id::text=current_setting('app.family_id',true));

ALTER TABLE identity.parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.parents FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_scope ON identity.parents USING(id::text=current_setting('app.family_id',true) OR synthetic_key=current_setting('app.login_identity',true)) WITH CHECK(synthetic_key=current_setting('app.login_identity',true) OR id::text=current_setting('app.family_id',true));
ALTER TABLE identity.registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY registration_scope ON identity.registrations USING(family_id::text=current_setting('app.family_id',true)) WITH CHECK(family_id::text=current_setting('app.family_id',true));
ALTER TABLE identity.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_scope ON identity.sessions USING(digest=current_setting('app.session_digest',true) OR family_id::text=current_setting('app.family_id',true)) WITH CHECK(digest=current_setting('app.session_digest',true) OR family_id::text=current_setting('app.family_id',true));
ALTER TABLE identity.proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY proof_scope ON identity.proofs USING(session_id::text=current_setting('app.session_id',true)) WITH CHECK(session_id::text=current_setting('app.session_id',true));
