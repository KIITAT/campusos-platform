-- Anonymise a restored copy for staging (P1-11, decision 389). Run as the owner, in one
-- transaction: PGOPTIONS='-c campusos.anonymise=staging' psql -1 -f this-file.
-- Never on production: it overwrites every person.
DO $$
BEGIN
  IF coalesce(current_setting('campusos.anonymise', true), '') <> 'staging' THEN
    RAISE EXCEPTION 'refusing to anonymise: set campusos.anonymise=staging';
  END IF;
END $$;

CREATE TEMP TABLE staging_people ON COMMIT DROP AS
  SELECT id FROM public.users WHERE erased_at IS NULL;

UPDATE public.users SET erased_at = now() WHERE id IN (SELECT id FROM staging_people);
-- Both functions work per institution: forget_credentials needs app.institution_id set to the person's.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id, institution_id FROM public.users LOOP
    PERFORM public.campusos_erase_subject(u.id);
    IF u.institution_id IS NOT NULL THEN
      PERFORM set_config('app.institution_id', u.institution_id::text, true);
      PERFORM public.campusos_forget_credentials(u.id);
    END IF;
  END LOOP;
  PERFORM set_config('app.institution_id', '', true);
END $$;
-- Staging needs no production sign-in at all; this also covers people without an institution.
DELETE FROM public.sessions;
DELETE FROM public.accounts;
UPDATE public.users
   SET name = 'Person ' || left(id, 8),
       email = 'person+' || id || '@staging.invalid',
       "emailVerified" = NULL, image = NULL, date_of_birth = NULL, erased_at = NULL
 WHERE id IN (SELECT id FROM staging_people);
UPDATE public.users SET email = 'person+' || id || '@staging.invalid' WHERE id NOT IN (SELECT id FROM staging_people);

DELETE FROM public.device_tokens;
DELETE FROM public."verificationToken";
-- An invitation nobody accepted is linked to no user, so the erasure never reached it.
UPDATE public.invitations SET email = 'person+' || id || '@staging.invalid';

SET LOCAL session_replication_role = replica;
UPDATE public.audit_log SET detail = NULL, actor_email = NULL, reason = 'redacted for staging';
UPDATE public.platform_audit_log SET detail = NULL, actor_email = NULL, reason = 'redacted for staging';
SET LOCAL session_replication_role = origin;
