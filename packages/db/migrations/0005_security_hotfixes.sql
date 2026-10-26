-- P0-01 security hotfixes: DATA-03, SEC-05, AUD-01.
--
-- Forward-only. Rollback is a later migration that drops the two triggers and
-- their functions and re-grants what is revoked here; btree_gist stays, because
-- finance needs it. For an upgrade, the preferred rollback is restoring the
-- pre-upgrade backup with the matching image (decision 162).

-- Pre-flight: refuse with a plain message, before anything has changed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') THEN
    RAISE EXCEPTION 'btree_gist is not available on this server. It ships in the PostgreSQL contrib package (every official image and managed Postgres has it).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
END $$;
--> statement-breakpoint

-- DATA-03. finance/0005 builds an exclusion constraint over a uuid column,
-- which needs btree_gist, and only academic's migrations created it. So a
-- company installing finance (or hr, which depends on it) without academic
-- could not install at all. Core always migrates before any module, so the
-- extension lives here. It is a trusted extension: a non-superuser database
-- owner on managed Postgres may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- SEC-05. The application role is what every request and every plugin runs
-- as. It reads no credential, and it cannot create, rename, suspend or entitle
-- an institution: those tables have no row-level security, so a write here
-- reaches every tenant. The auth role (granted by the host's migrate) does the
-- few writes the product makes; the console runs as the owner.
REVOKE ALL ON "sessions", "accounts", "verificationToken", "device_tokens" FROM campusos_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "institutions", "institution_modules" FROM campusos_app;
--> statement-breakpoint

-- DATA-09, defence in depth. No product path deletes a person: erasure
-- anonymises in place. A delete by the application role would cascade into
-- financial history and null the attribution on posted documents.
REVOKE DELETE, TRUNCATE ON "users" FROM campusos_app;
--> statement-breakpoint

-- AUD-01. The audit trail is append-only, for every role, the owner included.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM campusos_app;
--> statement-breakpoint

-- The one exception is offboarding: when the institution row is already gone,
-- its trail goes with it through the foreign key's cascade. Anything else --
-- an update, a direct delete, or deleting a person, which would null the actor
-- on every row they wrote -- is refused. People are erased, not deleted.
--
-- Not yet tamper-evident: the owner can still disable a trigger. The hash
-- chain and off-host anchor are P0-02.
CREATE FUNCTION campusos_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_log_append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION campusos_audit_log_append_only();
--> statement-breakpoint

-- TRUNCATE fires no row trigger, so it gets a statement trigger of its own.
CREATE FUNCTION campusos_audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_log_append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION campusos_audit_log_no_truncate();
