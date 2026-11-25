-- P1-13c: school promotion and detention (MG-04, NEW-121; decisions 950, 951 of plans/P1-13c.md).
-- Adds academic_programs.next_program_id, academic_sections.school_promoted_at, and the derived
-- (school_program_id, school_admission_year) on academic_section_members, which a partial unique index
-- turns into "one section per school class and session". Triggers fill the derived columns, refuse new
-- members of a promoted section, and freeze the identity of school programmes and sections.
-- Numbered 0013: 0011 (P1-13a) and 0012 (P1-12a) are on main.
--
-- Pre-flight: runs inside the migration, under SHARE ROW EXCLUSIVE locks on the three tables, and halts
-- with a message when either of these returns a row. Repair is the owner's, never automatic:
--   SELECT m.institution_id, m.section_id, m.user_id
--     FROM public.academic_section_members m
--     LEFT JOIN public.academic_sections s
--       ON s.id=m.section_id AND s.institution_id=m.institution_id
--     LEFT JOIN public.academic_programs p
--       ON p.id=s.program_id AND p.institution_id=s.institution_id
--    WHERE p.id IS NULL;
--   SELECT m.institution_id, m.user_id, s.program_id, s.admission_year,
--          array_agg(m.section_id ORDER BY m.section_id) AS section_ids
--     FROM public.academic_section_members m
--     JOIN public.academic_sections s ON s.id=m.section_id AND s.institution_id=m.institution_id
--     JOIN public.academic_programs p ON p.id=s.program_id AND p.institution_id=s.institution_id
--    WHERE p.level='school'
--    GROUP BY m.institution_id,m.user_id,s.program_id,s.admission_year
--   HAVING count(*)>1;
--
-- Rollback (forward, under change control; save next_program_id and school_promoted_at first):
--   DROP TRIGGER academic_school_section_identity ON public.academic_sections;
--   DROP TRIGGER academic_school_program_identity ON public.academic_programs;
--   DROP FUNCTION public.academic_school_identity_fixed();
--   DROP TRIGGER academic_school_member_key ON public.academic_section_members;
--   DROP FUNCTION public.academic_school_member_key();
--   DROP INDEX public.academic_school_member_one_section;
--   ALTER TABLE public.academic_section_members DROP COLUMN school_admission_year, DROP COLUMN school_program_id;
--   ALTER TABLE public.academic_sections DROP COLUMN school_promoted_at;
--   ALTER TABLE public.academic_programs DROP CONSTRAINT academic_school_successor_fk,
--     DROP CONSTRAINT academic_school_successor, DROP COLUMN next_program_id;
--   DROP INDEX public.academic_programs_tenant_id;
--
-- One DO statement: the host splits on statement breakpoints and psql reads the file in autocommit mode.
DO $migration$
BEGIN
LOCK TABLE public.academic_programs, public.academic_sections,
           public.academic_section_members IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM public.academic_section_members m
    LEFT JOIN public.academic_sections s ON s.id=m.section_id AND s.institution_id=m.institution_id
    LEFT JOIN public.academic_programs p ON p.id=s.program_id AND p.institution_id=s.institution_id
    WHERE p.id IS NULL
  ) THEN RAISE EXCEPTION 'academic 0013: resolve inconsistent membership tenants first'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.academic_section_members m
    JOIN public.academic_sections s ON s.id=m.section_id AND s.institution_id=m.institution_id
    JOIN public.academic_programs p ON p.id=s.program_id AND p.institution_id=s.institution_id
    WHERE p.level='school'
    GROUP BY m.institution_id,m.user_id,s.program_id,s.admission_year HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'academic 0013: resolve duplicate school memberships first'; END IF;
CREATE UNIQUE INDEX academic_programs_tenant_id ON public.academic_programs(institution_id,id);
ALTER TABLE public.academic_programs ADD COLUMN next_program_id uuid,
  ADD CONSTRAINT academic_school_successor_fk FOREIGN KEY (institution_id,next_program_id)
    REFERENCES public.academic_programs(institution_id,id),
  ADD CONSTRAINT academic_school_successor CHECK
    (next_program_id IS NULL OR (level='school' AND next_program_id<>id));
ALTER TABLE public.academic_sections ADD COLUMN school_promoted_at timestamptz;
ALTER TABLE public.academic_section_members ADD COLUMN school_program_id uuid,
  ADD COLUMN school_admission_year smallint;
UPDATE public.academic_section_members m
   SET school_program_id=s.program_id, school_admission_year=s.admission_year
  FROM public.academic_sections s JOIN public.academic_programs p
    ON p.id=s.program_id AND p.institution_id=s.institution_id
 WHERE s.id=m.section_id AND s.institution_id=m.institution_id AND p.level='school';
CREATE UNIQUE INDEX academic_school_member_one_section ON public.academic_section_members
  (institution_id,user_id,school_program_id,school_admission_year) WHERE school_program_id IS NOT NULL;
CREATE FUNCTION public.academic_school_member_key() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE cohort record;
BEGIN
  SELECT s.program_id,s.admission_year,s.school_promoted_at,p.level
    INTO cohort FROM public.academic_sections s JOIN public.academic_programs p
      ON p.id=s.program_id AND p.institution_id=s.institution_id
   WHERE s.id=NEW.section_id AND s.institution_id=NEW.institution_id
   FOR SHARE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'section is missing from membership tenant' USING ERRCODE='23503';
  END IF;
  IF cohort.level='school' THEN
    IF cohort.school_promoted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.academic_section_members m
       WHERE m.section_id=NEW.section_id AND m.institution_id=NEW.institution_id AND m.user_id=NEW.user_id
    ) THEN
      RAISE EXCEPTION 'school section finalised'
        USING ERRCODE='23514', CONSTRAINT='academic_school_section_finalised';
    END IF;
    NEW.school_program_id:=cohort.program_id;
    NEW.school_admission_year:=cohort.admission_year;
  ELSE
    NEW.school_program_id:=NULL;
    NEW.school_admission_year:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER academic_school_member_key BEFORE INSERT OR UPDATE ON public.academic_section_members
  FOR EACH ROW EXECUTE FUNCTION public.academic_school_member_key();
CREATE FUNCTION public.academic_school_identity_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='academic_programs' THEN
    IF (OLD.level='school' OR NEW.level='school') AND
       (OLD.level,OLD.institution_id,OLD.id) IS DISTINCT FROM (NEW.level,NEW.institution_id,NEW.id) THEN
      RAISE EXCEPTION 'school programme identity is fixed' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (OLD.institution_id,OLD.id,OLD.program_id,OLD.admission_year)
        IS DISTINCT FROM (NEW.institution_id,NEW.id,NEW.program_id,NEW.admission_year)
        AND EXISTS (
          SELECT 1 FROM public.academic_programs p
           WHERE p.level='school' AND p.id IN (OLD.program_id,NEW.program_id)
        ) THEN
      RAISE EXCEPTION 'school section identity is fixed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER academic_school_program_identity BEFORE UPDATE OF level,institution_id,id ON public.academic_programs
  FOR EACH ROW EXECUTE FUNCTION public.academic_school_identity_fixed();
CREATE TRIGGER academic_school_section_identity BEFORE UPDATE OF institution_id,id,program_id,admission_year ON public.academic_sections
  FOR EACH ROW EXECUTE FUNCTION public.academic_school_identity_fixed();
END $migration$;
