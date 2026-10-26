-- P0-02: the audit trail becomes tamper-evident (AUD-01), and deleting an
-- institution leaves a record that outlives it (NEW-09).
--
-- 0005 made audit_log append-only, but the owner can still switch a trigger
-- off. What makes the trail evidence is a hash chain per institution, checked
-- by code outside the database (packages/db/src/audit-chain.ts) against anchors
-- kept off the server. Each audit row is sealed into audit_chain by a deferred
-- trigger as its transaction commits, so the chain is in commit order and the
-- per-institution lock is held only for the seal, not from the first audit row
-- to the commit. Events with no institution go to platform_audit_log, chained
-- in the row itself.
--
-- Hash format, version 1. Every field is `<byte length>:<text>`, or `~` for
-- NULL, so the bytes can be rebuilt exactly without any escaping rules:
--   content = sha256(salt || utf8(f(actor_email) f(reason) f(detail::text)))
--   hash    = sha256(prev_hash || utf8(f('campusos-audit-v1') f(chain) f(seq) f(id)
--               f(at, UTC, microseconds) f(institution_id) f(actor_id) f(module_id)
--               f(action) f(entity) f(entity_id)) || content)
--   genesis = sha256(utf8('campusos-audit-genesis:' || chain))
-- where chain is the institution id, or 'platform'. The content enters only as
-- a digest salted per row, so a lawful redaction can later remove the content
-- and its salt without breaking the chain (P1-08, AUD-03).
--
-- Rows already in audit_log are sealed here, per institution in (at, id) order,
-- with no salt. That attests to the history as it stood at this upgrade, not
-- before it.
--
-- Forward-only. Rollback is a later migration that drops the triggers and
-- functions created here; audit() keeps working without a chain, so callers
-- fail neither open nor closed. For an upgrade, the preferred rollback is
-- restoring the pre-upgrade backup with the matching image (decision 162).

-- Pre-flight: refuse with a plain message, before anything has changed.
DO $$
BEGIN
  IF (SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()) <> 'UTF8' THEN
    RAISE EXCEPTION 'the database encoding must be UTF8: the audit chain is defined over UTF-8 bytes';
  END IF;
  IF current_setting('server_version_num')::int < 110000 THEN
    RAISE EXCEPTION 'PostgreSQL 11 or later is required for sha256()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN (
       'campusos_audit_field', 'campusos_audit_genesis', 'campusos_audit_hash', 'campusos_audit_salt',
       'campusos_audit_seal', 'campusos_platform_audit_chain', 'campusos_audit_append_only',
       'campusos_audit_no_truncate', 'campusos_institution_deleted')) THEN
    RAISE EXCEPTION 'an audit chain function already exists: this migration was applied by hand, or in part';
  END IF;
  RAISE NOTICE 'sealing % existing audit rows into their chains', (SELECT count(*) FROM audit_log);
END $$;
--> statement-breakpoint

-- The default privileges from docker/init.sql gave the application role every
-- right on the two new tables. It reads its own institution's links (RLS) and
-- has no business with platform events at all.
REVOKE ALL ON "audit_chain", "platform_audit_log" FROM campusos_app;
--> statement-breakpoint
GRANT SELECT ON "audit_chain" TO campusos_app;
--> statement-breakpoint

CREATE FUNCTION campusos_audit_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT CASE WHEN v IS NULL THEN '~' ELSE octet_length(v)::text || ':' || v END $$;
--> statement-breakpoint

CREATE FUNCTION campusos_audit_genesis(chain text) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT sha256(convert_to('campusos-audit-genesis:' || chain, 'UTF8')) $$;
--> statement-breakpoint

CREATE FUNCTION campusos_audit_hash(
  prev bytea, chain text, seq bigint, id uuid, stamp timestamptz, tenant uuid,
  actor_id text, module_id text, action text, entity text, entity_id text,
  actor_email text, reason text, detail jsonb, salt bytea
) RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT sha256(
    prev
    || convert_to(
         campusos_audit_field('campusos-audit-v1') || campusos_audit_field(chain)
         || campusos_audit_field(seq::text) || campusos_audit_field(id::text)
         || campusos_audit_field(to_char(stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
         || campusos_audit_field(tenant::text) || campusos_audit_field(actor_id)
         || campusos_audit_field(module_id) || campusos_audit_field(action)
         || campusos_audit_field(entity) || campusos_audit_field(entity_id),
         'UTF8')
    || sha256(coalesce(salt, ''::bytea) || convert_to(
         campusos_audit_field(actor_email) || campusos_audit_field(reason) || campusos_audit_field(detail::text),
         'UTF8')))
$$;
--> statement-breakpoint

-- Whatever the caller sends, the database chooses the salt.
CREATE FUNCTION campusos_audit_salt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_salt BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION campusos_audit_salt();
--> statement-breakpoint

-- The two new tables are append-only for every role, the owner included. A
-- tenant's links follow it out when it is offboarded, as its rows do (0005).
CREATE FUNCTION campusos_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_chain' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;
--> statement-breakpoint
CREATE FUNCTION campusos_audit_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_chain_append_only BEFORE UPDATE OR DELETE ON "audit_chain"
  FOR EACH ROW EXECUTE FUNCTION campusos_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_chain_no_truncate BEFORE TRUNCATE ON "audit_chain"
  FOR EACH STATEMENT EXECUTE FUNCTION campusos_audit_no_truncate();
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_append_only BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION campusos_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_no_truncate BEFORE TRUNCATE ON "platform_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION campusos_audit_no_truncate();
--> statement-breakpoint

-- The platform chain: rare events, so the one lock is simply held to commit.
-- Two-key advisory locks live in their own key space, apart from the one-key
-- locks the modules take; 1096107092 is 'AUDT'.
CREATE FUNCTION campusos_platform_audit_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(1096107092, 0);
  SELECT p.seq, p.hash INTO last_seq, last_hash FROM platform_audit_log p ORDER BY p.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_seq := 0;
    last_hash := campusos_audit_genesis('platform');
  END IF;
  NEW.salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  NEW.seq := last_seq + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := campusos_audit_hash(last_hash, 'platform', NEW.seq, NEW.id, NEW.at, NEW.institution_id,
    NEW.actor_id, NEW.module_id, NEW.action, NEW.entity, NEW.entity_id, NEW.actor_email, NEW.reason,
    NEW.detail, NEW.salt);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_audit_log_chain BEFORE INSERT ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION campusos_platform_audit_chain();
--> statement-breakpoint

-- NEW-09. Deleting an institution takes its trail with it (0005), so the
-- deletion is recorded where it cannot follow: the platform chain, with the
-- final head, so a verifier can tell an offboarding from a vanished chain.
CREATE FUNCTION campusos_institution_deleted() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
  rows_left bigint;
BEGIN
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
CREATE TRIGGER institutions_deleted BEFORE DELETE ON "institutions"
  FOR EACH ROW EXECUTE FUNCTION campusos_institution_deleted();
--> statement-breakpoint

-- Seal what is already there, with writers held off, before the seal trigger
-- exists. Run the upgrade in the maintenance window (decision 162).
LOCK TABLE "audit_log" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  r record;
  tenant uuid;
  last_seq bigint;
  last_hash bytea;
  h bytea;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY institution_id, at, id LOOP
    IF tenant IS DISTINCT FROM r.institution_id THEN
      tenant := r.institution_id;
      last_seq := 0;
      last_hash := campusos_audit_genesis(tenant::text);
    END IF;
    last_seq := last_seq + 1;
    h := campusos_audit_hash(last_hash, tenant::text, last_seq, r.id, r.at, r.institution_id, r.actor_id,
      r.module_id, r.action, r.entity, r.entity_id, r.actor_email, r.reason, r.detail, r.salt);
    INSERT INTO audit_chain (audit_id, institution_id, seq, prev_hash, hash)
    VALUES (r.id, tenant, last_seq, last_hash, h);
    last_hash := h;
  END LOOP;
END $$;
--> statement-breakpoint

-- From here on, every audit row is sealed as its transaction commits. A row
-- deleted again before then can only have gone with its institution, so it is
-- skipped. Links for one institution queue on its own lock; institutions do
-- not wait for each other.
CREATE FUNCTION campusos_audit_seal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
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
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER audit_log_seal AFTER INSERT ON "audit_log"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION campusos_audit_seal();
