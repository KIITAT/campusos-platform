CREATE TABLE placement_officers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id), active boolean NOT NULL DEFAULT true,
  UNIQUE(institution_id, user_id)
);
CREATE TABLE placement_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) > 0), website text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(institution_id, name), UNIQUE(id, institution_id)
);
CREATE TABLE placement_drives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL, program_id uuid REFERENCES academic_programs(id), title text NOT NULL CHECK(length(trim(title)) > 0),
  closes_at timestamptz NOT NULL, min_cgpa numeric(4,2) NOT NULL DEFAULT 0 CHECK(min_cgpa BETWEEN 0 AND 10),
  max_backlogs integer NOT NULL DEFAULT 0 CHECK(max_backlogs BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, institution_id), FOREIGN KEY(company_id,institution_id) REFERENCES placement_companies(id,institution_id)
);
CREATE TABLE placement_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  drive_id uuid NOT NULL, student_id text NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'applied'
    CHECK(status IN ('applied','shortlisted','rejected','withdrawn','offered','accepted','declined')),
  eligibility jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(drive_id,student_id), UNIQUE(id,institution_id),
  FOREIGN KEY(drive_id,institution_id) REFERENCES placement_drives(id,institution_id)
);
CREATE TABLE placement_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  drive_id uuid NOT NULL, name text NOT NULL CHECK(length(trim(name)) > 0), position integer NOT NULL CHECK(position > 0),
  UNIQUE(drive_id,position), UNIQUE(id,institution_id), FOREIGN KEY(drive_id,institution_id) REFERENCES placement_drives(id,institution_id)
);
CREATE TABLE placement_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  application_id uuid NOT NULL, round_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN ('passed','failed')),
  note text NOT NULL CHECK(length(trim(note)) > 0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(application_id,round_id),
  FOREIGN KEY(application_id,institution_id) REFERENCES placement_applications(id,institution_id),
  FOREIGN KEY(round_id,institution_id) REFERENCES placement_rounds(id,institution_id)
);
CREATE TABLE placement_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  application_id uuid NOT NULL UNIQUE, student_id text NOT NULL REFERENCES users(id), annual_paise numeric(15,0) NOT NULL CHECK(annual_paise > 0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(application_id,institution_id) REFERENCES placement_applications(id,institution_id)
);
CREATE UNIQUE INDEX placement_offers_one_accepted ON placement_offers(institution_id,student_id) WHERE status='accepted';
CREATE INDEX placement_applications_student ON placement_applications(institution_id,student_id);
CREATE INDEX placement_drives_status ON placement_drives(institution_id,status,closes_at);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['placement_officers','placement_companies','placement_drives','placement_applications','placement_rounds','placement_results','placement_offers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO campusos_app USING (institution_id = nullif(current_setting(''app.institution_id'',true),'''')::uuid) WITH CHECK (institution_id = nullif(current_setting(''app.institution_id'',true),'''')::uuid)',table_name || '_tenant_isolation',table_name);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION placement_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'placement_officers' THEN
    IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND institution_id=NEW.institution_id AND (NOT NEW.active OR (erased_at IS NULL AND role IN ('faculty','hod','institution_admin','super_admin')))) THEN
      RAISE EXCEPTION 'placement officer must be current institutional staff';
    END IF;
  ELSIF TG_TABLE_NAME = 'placement_drives' THEN
    IF NEW.program_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM academic_programs WHERE id=NEW.program_id AND institution_id=NEW.institution_id) THEN
      RAISE EXCEPTION 'placement programme belongs to another institution';
    END IF;
  ELSIF TG_TABLE_NAME = 'placement_applications' OR TG_TABLE_NAME = 'placement_offers' THEN
    IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.student_id AND institution_id=NEW.institution_id AND erased_at IS NULL AND role='student') THEN
      RAISE EXCEPTION 'placement student must belong to the institution';
    END IF;
    IF TG_TABLE_NAME = 'placement_offers' THEN
      IF NOT EXISTS(SELECT 1 FROM placement_applications WHERE id=NEW.application_id AND student_id=NEW.student_id) THEN
        RAISE EXCEPTION 'placement offer must name its applicant';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'placement_results' THEN
    IF NOT EXISTS(SELECT 1 FROM placement_applications applicant JOIN placement_rounds round ON round.drive_id=applicant.drive_id WHERE applicant.id=NEW.application_id AND round.id=NEW.round_id) THEN
      RAISE EXCEPTION 'placement round must belong to the application drive';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['placement_officers','placement_drives','placement_applications','placement_results','placement_offers'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION placement_reference_guard()',table_name || '_references',table_name);
  END LOOP;
END $$;
