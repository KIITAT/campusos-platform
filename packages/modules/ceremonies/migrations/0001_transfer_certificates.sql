-- P1-13d: numbered school transfer certificates (MG-05, decisions 975 to 983).
-- Two tenant tables: a minimal immutable header (serial, lifecycle, who) and a
-- separate printable payload that registered erasure deletes. Adds only; no
-- existing row is touched.
--
-- Rollback (an installation that never issued one, both counts zero under locks):
--   DROP VIEW dpdp_subject.ceremonies_about;
--   DROP FUNCTION dpdp_subject.erase_ceremonies(text);
--   DROP TABLE public.ceremony_transfer_payloads;
--   DROP FUNCTION public.ceremony_transfer_payload_guard();
--   DROP TABLE public.ceremony_transfer_certificates;
--   DROP FUNCTION public.ceremony_transfer_subject_guard();

DO $migration$
BEGIN
  IF to_regclass('public.ceremony_certificates') IS NULL OR
     to_regclass('public.academic_student_programs') IS NULL OR
     to_regprocedure('public.campusos_docstatus_guard()') IS NULL OR
     to_regnamespace('dpdp_subject') IS NULL THEN
    RAISE EXCEPTION 'ceremonies 0001 requires ceremonies 0000 and the core document and erasure hooks';
  END IF;
  CREATE TABLE public.ceremony_transfer_certificates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    student_program_id uuid NOT NULL REFERENCES public.academic_student_programs(id) ON DELETE RESTRICT,
    issue_year smallint NOT NULL,
    serial_no integer NOT NULL CHECK (serial_no BETWEEN 1 AND 999999),
    issued_on date NOT NULL CHECK (issue_year = extract(year FROM issued_on)),
    docstatus text NOT NULL DEFAULT 'draft' CHECK (docstatus IN ('draft','submitted','cancelled')),
    submitted_at timestamptz,
    submitted_by text,
    cancelled_at timestamptz,
    cancelled_by text,
    cancel_reason text,
    amended_from uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ceremony_transfer_header_tenant UNIQUE (institution_id,id),
    CONSTRAINT ceremony_transfer_serial UNIQUE (institution_id,issue_year,serial_no),
    CONSTRAINT ceremony_transfer_amended_fk FOREIGN KEY (institution_id,amended_from)
      REFERENCES public.ceremony_transfer_certificates(institution_id,id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX ceremony_transfer_original
    ON public.ceremony_transfer_certificates(institution_id,student_program_id) WHERE amended_from IS NULL;
  CREATE UNIQUE INDEX ceremony_transfer_standing
    ON public.ceremony_transfer_certificates(institution_id,student_program_id) WHERE docstatus <> 'cancelled';
  CREATE UNIQUE INDEX ceremony_transfer_replacement
    ON public.ceremony_transfer_certificates(institution_id,amended_from) WHERE amended_from IS NOT NULL;
  CREATE INDEX ceremony_transfer_student ON public.ceremony_transfer_certificates(institution_id,student_id);
  CREATE INDEX ceremony_transfer_recent ON public.ceremony_transfer_certificates(institution_id,issued_on DESC,serial_no DESC,id DESC);
  ALTER TABLE public.ceremony_transfer_certificates ENABLE ROW LEVEL SECURITY;
  CREATE POLICY ceremony_transfer_certificates_tenant_isolation ON public.ceremony_transfer_certificates
    FOR ALL TO campusos_app USING (institution_id=nullif(current_setting('app.institution_id',true),'')::uuid)
    WITH CHECK (institution_id=nullif(current_setting('app.institution_id',true),'')::uuid);
  CREATE FUNCTION public.ceremony_transfer_subject_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM public.academic_student_programs sp
        JOIN public.academic_programs p ON p.id=sp.program_id AND p.institution_id=sp.institution_id
        JOIN public.users u ON u.id=sp.student_id AND u.institution_id=sp.institution_id
       WHERE sp.id=NEW.student_program_id AND sp.institution_id=NEW.institution_id
         AND u.id=NEW.student_id AND p.level='school' AND u.role='student'
    ) THEN
      RAISE EXCEPTION 'transfer certificate declaration does not match the pupil and institution'
        USING ERRCODE='23514', CONSTRAINT='transfer_subject_mismatch';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER ceremony_transfer_subject_guard BEFORE INSERT ON public.ceremony_transfer_certificates
    FOR EACH ROW EXECUTE FUNCTION public.ceremony_transfer_subject_guard();
  CREATE TRIGGER ceremony_transfer_docstatus BEFORE INSERT OR UPDATE OR DELETE
    ON public.ceremony_transfer_certificates FOR EACH ROW EXECUTE FUNCTION public.campusos_docstatus_guard();

  CREATE TABLE public.ceremony_transfer_payloads (
    certificate_id uuid PRIMARY KEY,
    institution_id uuid NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'
      AND coalesce(snapshot->>'format','')='cbse_annexure_i_v1'),
    CONSTRAINT ceremony_transfer_payload_header FOREIGN KEY (institution_id,certificate_id)
      REFERENCES public.ceremony_transfer_certificates(institution_id,id) ON DELETE CASCADE
  );
  ALTER TABLE public.ceremony_transfer_payloads ENABLE ROW LEVEL SECURITY;
  CREATE POLICY ceremony_transfer_payloads_tenant_isolation ON public.ceremony_transfer_payloads
    FOR ALL TO campusos_app USING (institution_id=nullif(current_setting('app.institution_id',true),'')::uuid)
    WITH CHECK (institution_id=nullif(current_setting('app.institution_id',true),'')::uuid);
  CREATE FUNCTION public.ceremony_transfer_payload_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
  DECLARE erased timestamptz;
  BEGIN
    IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
    IF TG_OP='INSERT' THEN
      SELECT u.erased_at INTO erased FROM public.ceremony_transfer_certificates c
        JOIN public.users u ON u.id=c.student_id AND u.institution_id=c.institution_id
       WHERE c.id=NEW.certificate_id AND c.institution_id=NEW.institution_id
       FOR SHARE OF u;
      IF FOUND AND erased IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP='DELETE' AND EXISTS (
      SELECT 1 FROM public.ceremony_transfer_certificates c
        JOIN public.users u ON u.id=c.student_id AND u.institution_id=c.institution_id
       WHERE c.id=OLD.certificate_id AND c.institution_id=OLD.institution_id AND u.erased_at IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'transfer certificate payload is locked'
      USING ERRCODE='23514', CONSTRAINT='transfer_payload_locked';
  END $$;
  CREATE TRIGGER ceremony_transfer_payload_locked BEFORE INSERT OR UPDATE OR DELETE
    ON public.ceremony_transfer_payloads FOR EACH ROW EXECUTE FUNCTION public.ceremony_transfer_payload_guard();

  CREATE VIEW dpdp_subject.ceremonies_about WITH (security_invoker=true) AS
    SELECT c.student_id AS subject_id, 'ceremony_transfer_payloads'::text AS source,
           jsonb_build_object('certificate_id',c.id,'snapshot',p.snapshot) AS row_data
      FROM public.ceremony_transfer_certificates c JOIN public.ceremony_transfer_payloads p
        ON p.certificate_id=c.id AND p.institution_id=c.institution_id;
  CREATE FUNCTION dpdp_subject.erase_ceremonies(who text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
  DECLARE erased_count integer;
  BEGIN
    DELETE FROM public.ceremony_transfer_payloads p USING public.ceremony_transfer_certificates c, public.users u
     WHERE p.certificate_id=c.id AND p.institution_id=c.institution_id
       AND c.student_id=who AND u.id=who AND u.institution_id=c.institution_id AND u.erased_at IS NOT NULL;
    GET DIAGNOSTICS erased_count=ROW_COUNT;
    RETURN jsonb_build_object('ceremony_transfer_payloads',erased_count);
  END $$;
  REVOKE ALL ON FUNCTION dpdp_subject.erase_ceremonies(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION dpdp_subject.erase_ceremonies(text) TO campusos_app;
  GRANT SELECT ON dpdp_subject.ceremonies_about TO campusos_app;
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.ceremony_transfer_certificates,public.ceremony_transfer_payloads TO campusos_app;
END $migration$;
