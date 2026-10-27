-- P0-02 review: four ways round the audit chain of 0007/0008 are closed
-- (AUD-01, NEW-09, NEW-12).
--
-- 1. The chain and guard functions were executable by PUBLIC. A role that can
--    create a temporary table could attach a SECURITY DEFINER trigger function
--    to it and run it with the owner's rights on a table it controls. EXECUTE
--    is revoked from PUBLIC; a trigger fires whatever its caller's rights, so
--    the triggers on the real tables are unaffected. Each definer function also
--    refuses to run on any table but its own.
-- 2. The append-only guards (0005 and 0008) are SECURITY INVOKER and named
--    `institutions` without a schema, so a session could create a temporary
--    table of that name, which pg_temp puts first on the search path, and make
--    a live institution look deleted (NEW-12). They now fix the search path
--    and name public.institutions.
-- 3. Anybody who could append to the platform chain could write an
--    `institution.deleted` or `audit.checkpoint` row, which the verifier took
--    as the explanation for a missing chain or a missing prefix. Those two
--    events are now written by the database only: `institution.deleted` from
--    the institutions trigger, `audit.checkpoint` not at all until P1-08.
-- 4. The caller chose `at`. A row dated 'infinity' could not be verified and
--    a row dated years back sorted out of place. The database now stamps it.
--
-- Forward-only. Rollback is a later migration restoring the 0008 bodies and
-- granting EXECUTE to PUBLIC again; nothing here touches a row.

-- Pre-flight: every function this replaces must be the one 0005 and 0008 made.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO missing
    FROM unnest(ARRAY['campusos_audit_field', 'campusos_audit_genesis', 'campusos_audit_hash',
                      'campusos_audit_salt', 'campusos_audit_append_only', 'campusos_audit_no_truncate',
                      'campusos_platform_audit_chain', 'campusos_institution_deleted', 'campusos_audit_seal',
                      'campusos_audit_log_append_only', 'campusos_audit_log_no_truncate']) AS f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = f);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'audit functions missing (%): apply 0005 and 0008 first', missing;
  END IF;
  RAISE NOTICE '% audit rows have an `at` that is not finite; they stay as sealed',
    (SELECT count(*) FROM audit_log WHERE NOT isfinite(at));
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  campusos_audit_field(text),
  campusos_audit_genesis(text),
  campusos_audit_hash(bytea, text, bigint, uuid, timestamptz, uuid, text, text, text, text, text, text, text, jsonb, bytea),
  campusos_audit_salt(),
  campusos_audit_append_only(),
  campusos_audit_no_truncate(),
  campusos_platform_audit_chain(),
  campusos_institution_deleted(),
  campusos_audit_seal(),
  campusos_audit_log_append_only(),
  campusos_audit_log_no_truncate()
FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION campusos_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public.institutions WHERE id = OLD.institution_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_log_append_only';
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION campusos_audit_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_chain' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public.institutions WHERE id = OLD.institution_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;
--> statement-breakpoint

-- Whatever the caller sends, the database chooses the salt and the time.
CREATE OR REPLACE FUNCTION campusos_audit_salt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  NEW.at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION campusos_platform_audit_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  IF TG_RELID <> 'public.platform_audit_log'::regclass THEN
    RAISE EXCEPTION 'campusos_platform_audit_chain() belongs to platform_audit_log'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the institutions trigger, one level down, records a deletion.
  IF NEW.action = 'audit.checkpoint' OR (NEW.action = 'institution.deleted' AND pg_trigger_depth() < 2) THEN
    RAISE EXCEPTION 'platform event % is written by the database only', NEW.action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(1096107092, 0);
  SELECT p.seq, p.hash INTO last_seq, last_hash FROM platform_audit_log p ORDER BY p.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_seq := 0;
    last_hash := campusos_audit_genesis('platform');
  END IF;
  NEW.at := now();
  NEW.salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  NEW.seq := last_seq + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := campusos_audit_hash(last_hash, 'platform', NEW.seq, NEW.id, NEW.at, NEW.institution_id,
    NEW.actor_id, NEW.module_id, NEW.action, NEW.entity, NEW.entity_id, NEW.actor_email, NEW.reason,
    NEW.detail, NEW.salt);
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION campusos_institution_deleted() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
  rows_left bigint;
BEGIN
  IF TG_RELID <> 'public.institutions'::regclass THEN
    RAISE EXCEPTION 'campusos_institution_deleted() belongs to institutions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(1096107092, hashtext(OLD.id::text));
  SELECT c.seq, c.hash INTO last_seq, last_hash
    FROM audit_chain c WHERE c.institution_id = OLD.id ORDER BY c.seq DESC LIMIT 1;
  SELECT count(*) INTO rows_left FROM audit_log WHERE institution_id = OLD.id;
  INSERT INTO platform_audit_log
    (institution_id, actor_id, actor_email, module_id, action, entity, entity_id, reason, detail)
  VALUES (OLD.id, NULL, NULL, 'core', 'institution.deleted', 'institutions', OLD.id::text,
          'the institution was deleted, and its audit trail with it',
          jsonb_build_object('slug', OLD.slug, 'finalSeq', last_seq, 'finalHash', encode(last_hash, 'hex'),
                             'auditRows', rows_left, 'by', session_user));
  RETURN OLD;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION campusos_audit_seal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  IF TG_RELID <> 'public.audit_log'::regclass THEN
    RAISE EXCEPTION 'campusos_audit_seal() belongs to audit_log'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(1096107092, hashtext(NEW.institution_id::text));
  SELECT c.seq, c.hash INTO last_seq, last_hash
    FROM audit_chain c WHERE c.institution_id = NEW.institution_id ORDER BY c.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_seq := 0;
    last_hash := campusos_audit_genesis(NEW.institution_id::text);
  END IF;
  INSERT INTO audit_chain (audit_id, institution_id, seq, prev_hash, hash)
  VALUES (NEW.id, NEW.institution_id, last_seq + 1, last_hash,
          campusos_audit_hash(last_hash, NEW.institution_id::text, last_seq + 1, NEW.id, NEW.at,
            NEW.institution_id, NEW.actor_id, NEW.module_id, NEW.action, NEW.entity, NEW.entity_id,
            NEW.actor_email, NEW.reason, NEW.detail, NEW.salt));
  RETURN NULL;
END $$;
