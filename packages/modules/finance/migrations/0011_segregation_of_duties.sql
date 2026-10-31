-- P0-07: segregation of duties on money (ACC-01).
-- 1. finance_sod_settings: single-officer mode, one row per institution, off by default.
-- 2. finance_single_officer(uuid), finance_doc_creator(text, uuid): invoker, stable, fixed search path.
-- 3. finance_approvals_not_by_creator: the creator does not approve their own document.
-- 4. finance_submit_not_by_creator: the creator does not submit a supplier bill, a supplier payment or a voucher.
-- Existing rows are not touched and nothing is refused at upgrade: see tools/p007-diagnostics.sql.
-- Rollback: a later migration dropping the four triggers and four functions and the table; or restore the
-- pre-upgrade backup with finance 0.7.0, whose code reads none of them.

CREATE TABLE "finance_sod_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"single_officer" boolean DEFAULT false NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_sod_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_sod_settings" ADD CONSTRAINT "finance_sod_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "finance_sod_settings_tenant_isolation" ON "finance_sod_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_single_officer(inst uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT single_officer FROM finance_sod_settings WHERE institution_id = inst), false)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_doc_creator(doc_type text, doc_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE doc_type
    WHEN 'purchase_order'   THEN (SELECT created_by   FROM finance_orders            WHERE id = doc_id)
    WHEN 'purchase_invoice' THEN (SELECT created_by   FROM finance_invoices          WHERE id = doc_id)
    WHEN 'payment_pay'      THEN (SELECT created_by   FROM finance_payments          WHERE id = doc_id)
    WHEN 'journal'          THEN (SELECT created_by   FROM finance_journals          WHERE id = doc_id)
    WHEN 'material_request' THEN (SELECT requested_by FROM finance_material_requests WHERE id = doc_id)
  END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_approval_not_by_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.decision = 'approved' AND NEW.decided_by IS NOT NULL
     AND NEW.decided_by = finance_doc_creator(NEW.doc_type, NEW.doc_id)
     AND NOT finance_single_officer(NEW.institution_id) THEN
    RAISE EXCEPTION 'the person who made a document cannot approve it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_sod_approver_is_creator';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finance_approvals_not_by_creator" BEFORE INSERT ON "finance_approvals" FOR EACH ROW EXECUTE FUNCTION finance_approval_not_by_creator();--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_submit_not_by_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE applies boolean;
BEGIN
  IF OLD.docstatus = 'draft' AND NEW.docstatus = 'submitted'
     AND NEW.created_by IS NOT NULL AND NEW.submitted_by = NEW.created_by THEN
    applies := CASE TG_TABLE_NAME
      WHEN 'finance_invoices' THEN NEW.kind = 'purchase' AND coalesce(NEW.source_module, '') <> 'finance-recurring'
      WHEN 'finance_payments' THEN NEW.kind = 'pay'
      WHEN 'finance_journals' THEN NEW.kind <> 'opening'
      ELSE false END;
    IF applies AND NOT finance_single_officer(NEW.institution_id) THEN
      RAISE EXCEPTION 'the person who made a document cannot submit it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_sod_submitter_is_creator';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finance_submit_not_by_creator_invoices" BEFORE UPDATE ON "finance_invoices" FOR EACH ROW EXECUTE FUNCTION finance_submit_not_by_creator();--> statement-breakpoint
CREATE TRIGGER "finance_submit_not_by_creator_payments" BEFORE UPDATE ON "finance_payments" FOR EACH ROW EXECUTE FUNCTION finance_submit_not_by_creator();--> statement-breakpoint
CREATE TRIGGER "finance_submit_not_by_creator_journals" BEFORE UPDATE ON "finance_journals" FOR EACH ROW EXECUTE FUNCTION finance_submit_not_by_creator();
