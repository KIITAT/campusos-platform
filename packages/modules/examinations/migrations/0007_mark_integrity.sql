-- Published marks move only by one person proposing and a different
-- administrator approving (P1-07c, AUD-05, decisions 875-882).
--
-- Until now the guard on exam_marks accepted any audit reason: one lecturer
-- could write the reason and the change, and unpublishing re-opened every mark.
-- This migration makes four things a property of the database:
--
--   1. publication is sticky (exams.ever_published): hiding results hides them,
--      it does not reopen the marks;
--   2. a published mark changes only inside a transaction that also carries an
--      approved request, made by one person and approved by another, and the
--      audit row that describes exactly that change;
--   3. every insert, score change and draft delete of a mark is kept, with the
--      value before and after, in an append-only history;
--   4. a revised or hidden mark is flagged (needs_recompute) so the official
--      outputs wait until the course is finalised again.
--
-- Pre-flight (must return zero before this runs on a database with data):
--   SELECT count(*) FROM exam_marks m LEFT JOIN exams e ON e.id = m.exam_id
--    WHERE e.id IS NULL OR e.institution_id <> m.institution_id
--       OR m.obtained > e.max_marks OR m.revision NOT BETWEEN 0 AND 32766;
--
-- Rollback (disposable databases only; production keeps the evidence and
-- freezes writes): see plans/P1-07c.md section 4.

ALTER TABLE public.exams ADD COLUMN ever_published boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE public.exam_marks ADD COLUMN needs_recompute boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE public.exams e SET ever_published = true WHERE e.published_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM public.audit_log a WHERE a.institution_id = e.institution_id
    AND a.module_id = 'examinations' AND a.entity = 'exams' AND a.entity_id = e.id::text
    AND a.action IN ('exam.published', 'exam.unpublished')
);--> statement-breakpoint

CREATE TABLE public.exam_mark_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  mark_id uuid NOT NULL REFERENCES public.exam_marks(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('correction', 'recheck', 're_evaluation')),
  status text NOT NULL CHECK (status IN ('requested', 'proposed', 'approved', 'rejected')),
  maker_id text, checker_id text,
  base_revision smallint NOT NULL CHECK (base_revision BETWEEN 0 AND 32766),
  proposed_score numeric(6,2), proposed_absent boolean,
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, approved_xid text,
  CHECK (checker_id IS NULL OR checker_id IS DISTINCT FROM maker_id),
  CHECK ((status IN ('approved', 'rejected')) = (checker_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'approved') = (approved_xid IS NOT NULL)),
  CHECK (status NOT IN ('proposed', 'approved') OR
    (maker_id IS NOT NULL AND proposed_absent IS NOT NULL AND
      ((proposed_absent AND proposed_score IS NULL) OR
       (NOT proposed_absent AND proposed_score IS NOT NULL AND proposed_score >= 0))))
);--> statement-breakpoint
CREATE UNIQUE INDEX exam_mark_requests_live ON public.exam_mark_requests(mark_id)
  WHERE status IN ('requested', 'proposed');--> statement-breakpoint
CREATE INDEX exam_mark_requests_page ON public.exam_mark_requests(institution_id, id DESC);--> statement-breakpoint
CREATE INDEX exam_mark_requests_student ON public.exam_mark_requests(student_id);--> statement-breakpoint
ALTER TABLE public.exam_mark_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY exam_mark_requests_tenant_isolation ON public.exam_mark_requests TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE public.exam_marks_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  mark_id uuid NOT NULL,
  student_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('insert', 'update', 'delete')),
  before_mark jsonb, after_mark jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);--> statement-breakpoint
CREATE INDEX exam_marks_history_mark ON public.exam_marks_history(institution_id, mark_id, at, id);--> statement-breakpoint
CREATE INDEX exam_marks_history_student ON public.exam_marks_history(student_id);--> statement-breakpoint
ALTER TABLE public.exam_marks_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY exam_marks_history_tenant_isolation ON public.exam_marks_history TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE FUNCTION public.exam_mark_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'mark review is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM exam_marks m WHERE
      (m.id, m.institution_id, m.student_id) = (NEW.mark_id, NEW.institution_id, NEW.student_id)) THEN
    RAISE EXCEPTION 'mark review ownership mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status NOT IN ('requested', 'proposed') THEN
    RAISE EXCEPTION 'invalid initial mark review state' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.id, OLD.institution_id, OLD.mark_id, OLD.student_id, OLD.kind, OLD.base_revision, OLD.created_at)
       IS DISTINCT FROM (NEW.id, NEW.institution_id, NEW.mark_id, NEW.student_id, NEW.kind, NEW.base_revision, NEW.created_at)
       OR NOT ((OLD.status = 'requested' AND NEW.status IN ('proposed', 'rejected')) OR
               (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected')))
       OR (NEW.status IN ('approved', 'rejected') AND (OLD.maker_id, OLD.proposed_score, OLD.proposed_absent)
            IS DISTINCT FROM (NEW.maker_id, NEW.proposed_score, NEW.proposed_absent)) THEN
      RAISE EXCEPTION 'invalid mark review transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.approved_xid := CASE WHEN NEW.status = 'approved' THEN pg_current_xact_id()::text END;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER exam_mark_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.exam_mark_requests
  FOR EACH ROW EXECUTE FUNCTION public.exam_mark_request_guard();--> statement-breakpoint

CREATE FUNCTION public.exam_mark_snapshot(score numeric, was_absent boolean, rev smallint) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('obtained', score, 'absent', was_absent, 'revision', rev)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.exam_marks_guard_published() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE e exams%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.id, OLD.institution_id, OLD.exam_id, OLD.student_id)
       IS DISTINCT FROM (NEW.id, NEW.institution_id, NEW.exam_id, NEW.student_id) THEN
      RAISE EXCEPTION 'mark identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF (OLD.obtained, OLD.absent, OLD.revision) IS NOT DISTINCT FROM
       (NEW.obtained, NEW.absent, NEW.revision) THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO e FROM exams WHERE id = NEW.exam_id AND institution_id = NEW.institution_id FOR SHARE;
  IF NOT FOUND OR NEW.obtained > e.max_marks THEN
    RAISE EXCEPTION 'invalid mark ownership or score' USING ERRCODE = '23514';
  END IF;
  IF NOT e.ever_published THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.revision = OLD.revision + 1 AND
       (OLD.obtained, OLD.absent) IS DISTINCT FROM (NEW.obtained, NEW.absent) AND EXISTS (
      SELECT 1 FROM exam_mark_requests r JOIN audit_log a ON a.id = r.id
      WHERE r.institution_id = NEW.institution_id AND r.mark_id = NEW.id
        AND r.status = 'approved' AND r.approved_xid = pg_current_xact_id()::text
        AND r.base_revision = OLD.revision AND r.checker_id = NEW.entered_by
        AND r.maker_id <> r.checker_id
        AND (r.proposed_score, r.proposed_absent) IS NOT DISTINCT FROM (NEW.obtained, NEW.absent)
        AND a.institution_id = r.institution_id AND a.actor_id = r.checker_id
        AND a.module_id = 'examinations' AND a.action = 'mark.revised'
        AND a.entity = 'exam_marks' AND a.entity_id = NEW.id::text
        AND length(btrim(a.reason)) BETWEEN 10 AND 500
        AND a.detail = jsonb_build_object('requestId', r.id, 'studentId', NEW.student_id, 'revision', NEW.revision,
          'from', exam_mark_snapshot(OLD.obtained, OLD.absent, OLD.revision),
          'to', exam_mark_snapshot(NEW.obtained, NEW.absent, NEW.revision))
    ) THEN
      NEW.needs_recompute := true;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'published mark requires its approved audited revision'
    USING ERRCODE = '23514', CONSTRAINT = 'exam_marks_approved_revision';
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.exam_marks_no_delete_published() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM exams WHERE id = OLD.exam_id AND ever_published FOR SHARE) THEN
    RAISE EXCEPTION 'a published mark cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.exams_guard_unpublish() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.ever_published := OLD.ever_published OR NEW.published_at IS NOT NULL;
    IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at
       AND nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
      RAISE EXCEPTION 'changing publication requires an audited reason' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.ever_published := NEW.published_at IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER exams_guard_unpublish ON public.exams;--> statement-breakpoint
CREATE TRIGGER exams_guard_unpublish BEFORE INSERT OR UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.exams_guard_unpublish();--> statement-breakpoint

CREATE FUNCTION public.exam_mark_write_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE bid uuid; tid uuid; sid text; prior jsonb; result jsonb;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.obtained, OLD.absent, OLD.revision) IS NOT DISTINCT FROM
       (NEW.obtained, NEW.absent, NEW.revision) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    bid := OLD.id; tid := OLD.institution_id; sid := OLD.student_id;
    prior := exam_mark_snapshot(OLD.obtained, OLD.absent, OLD.revision);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    bid := NEW.id; tid := NEW.institution_id; sid := NEW.student_id;
    result := exam_mark_snapshot(NEW.obtained, NEW.absent, NEW.revision);
  END IF;
  INSERT INTO exam_marks_history(institution_id, mark_id, student_id, event, before_mark, after_mark)
    VALUES (tid, bid, sid, lower(TG_OP), prior, result);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- A delete is recorded BEFORE it happens: the cascade exemption above reads the
-- trigger depth, and an AFTER row trigger of a cascaded delete runs at depth 1.
CREATE TRIGGER exam_mark_write_history_change AFTER INSERT OR UPDATE ON public.exam_marks
  FOR EACH ROW EXECUTE FUNCTION public.exam_mark_write_history();--> statement-breakpoint
CREATE TRIGGER exam_mark_write_history_delete BEFORE DELETE ON public.exam_marks
  FOR EACH ROW EXECUTE FUNCTION public.exam_mark_write_history();--> statement-breakpoint
CREATE FUNCTION public.exam_marks_history_protect() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'mark history is append-only' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER exam_marks_history_protect BEFORE INSERT OR UPDATE OR DELETE ON public.exam_marks_history
  FOR EACH ROW EXECUTE FUNCTION public.exam_marks_history_protect();--> statement-breakpoint
GRANT SELECT, INSERT ON public.exam_marks_history TO campusos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.exam_mark_requests TO campusos_app;--> statement-breakpoint
-- Conservative: every mark of an exam that was ever published and is now hidden,
-- and every already-revised mark, waits for its course to be finalised again.
UPDATE public.exam_marks m SET needs_recompute = true FROM public.exams e
WHERE e.id = m.exam_id AND e.institution_id = m.institution_id
  AND e.ever_published AND (e.published_at IS NULL OR m.revision > 0);
