-- P1-08c: a chained, append-only log of who opened a sensitive record, and the
-- institution's privacy officer who alone reads it (AUD-07). New objects only,
-- so no existing row can violate anything.
--
-- Rollback (owner; also remove the 0015 row from the drizzle journal):
--   DROP TABLE sensitive_reads, privacy_officers;
--   DROP FUNCTION campusos_sensitive_reads_chain(), campusos_sensitive_reads_append_only(), privacy_officer_staff();
DO $$ BEGIN
  IF to_regprocedure('public.campusos_audit_hash(bytea,text,bigint,uuid,timestamptz,uuid,text,text,text,text,text,text,text,jsonb,bytea)') IS NULL THEN
    RAISE EXCEPTION 'core migration 0008 (audit chain) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE sensitive_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  reader_id text REFERENCES users(id) ON DELETE SET NULL,
  subject_id text REFERENCES users(id) ON DELETE SET NULL,
  module_id text NOT NULL,
  kind text NOT NULL CONSTRAINT sensitive_reads_kind CHECK (kind ~ '^[a-z]+\.[a-z_]+$'),
  entity text NOT NULL,
  entity_id text NOT NULL,
  purpose text NOT NULL CONSTRAINT sensitive_reads_purpose CHECK (length(purpose) BETWEEN 3 AND 60),
  at timestamptz NOT NULL DEFAULT now(),
  salt bytea,
  seq bigint NOT NULL,
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL,
  CONSTRAINT sensitive_reads_seq UNIQUE (institution_id, seq)
);
--> statement-breakpoint
CREATE INDEX sensitive_reads_at ON sensitive_reads (institution_id, at DESC);
--> statement-breakpoint
CREATE INDEX sensitive_reads_subject ON sensitive_reads (institution_id, subject_id, at DESC);
--> statement-breakpoint
ALTER TABLE sensitive_reads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sensitive_reads_tenant_isolation ON sensitive_reads AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
-- ponytail: one lock per institution; per-reader chains if read volume ever matters.
CREATE FUNCTION campusos_sensitive_reads_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
  chain text := 'reads:' || NEW.institution_id::text;
BEGIN
  IF TG_RELID <> 'public.sensitive_reads'::regclass THEN
    RAISE EXCEPTION 'campusos_sensitive_reads_chain() belongs to sensitive_reads' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(1096107092, hashtext(chain));
  SELECT r.seq, r.hash INTO last_seq, last_hash FROM sensitive_reads r
   WHERE r.institution_id = NEW.institution_id ORDER BY r.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_seq := 0;
    last_hash := campusos_audit_genesis(chain);
  END IF;
  NEW.id := gen_random_uuid();
  NEW.at := now();
  NEW.salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  NEW.seq := last_seq + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := campusos_audit_hash(last_hash, chain, NEW.seq, NEW.id, NEW.at, NEW.institution_id,
    NEW.reader_id, NEW.module_id, NEW.kind, NEW.entity, NEW.entity_id, NEW.subject_id, NEW.purpose,
    NULL::jsonb, NEW.salt);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sensitive_reads_chain BEFORE INSERT ON sensitive_reads
  FOR EACH ROW EXECUTE FUNCTION campusos_sensitive_reads_chain();
--> statement-breakpoint
CREATE FUNCTION campusos_sensitive_reads_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Nested, not AND: OLD does not exist in the TRUNCATE (statement) trigger.
  IF TG_LEVEL = 'ROW' THEN
    IF pg_trigger_depth() > 1
       AND NOT EXISTS (SELECT 1 FROM public.institutions WHERE id = OLD.institution_id) THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;
  RAISE EXCEPTION 'sensitive_reads is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'sensitive_reads_append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER sensitive_reads_append_only BEFORE UPDATE OR DELETE ON sensitive_reads
  FOR EACH ROW EXECUTE FUNCTION campusos_sensitive_reads_append_only();
--> statement-breakpoint
CREATE TRIGGER sensitive_reads_no_truncate BEFORE TRUNCATE ON sensitive_reads
  FOR EACH STATEMENT EXECUTE FUNCTION campusos_sensitive_reads_append_only();
--> statement-breakpoint
CREATE TABLE privacy_officers (
  institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  named_by text REFERENCES users(id) ON DELETE SET NULL,
  named_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE privacy_officers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY privacy_officers_tenant_isolation ON privacy_officers AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION privacy_officer_staff() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = NEW.user_id AND institution_id = NEW.institution_id
                    AND role NOT IN ('student', 'parent', 'pending')) THEN
    RAISE EXCEPTION 'the privacy officer is a member of staff'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_officer_staff';
  END IF;
  NEW.named_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER privacy_officers_staff BEFORE INSERT OR UPDATE ON privacy_officers
  FOR EACH ROW EXECUTE FUNCTION privacy_officer_staff();
--> statement-breakpoint
REVOKE ALL ON sensitive_reads, privacy_officers FROM campusos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON sensitive_reads TO campusos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON privacy_officers TO campusos_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_sensitive_reads_chain(), campusos_sensitive_reads_append_only(), privacy_officer_staff() FROM PUBLIC;
