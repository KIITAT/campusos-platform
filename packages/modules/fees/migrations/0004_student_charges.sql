-- A charge on one student rather than a programme -- a backlog paper, a
-- duplicate admit card -- billed with everything else on the next invoice.
-- Fixed once raised; cancelled only before an invoice carries it, because after
-- that the books have it and the way back is a waiver or a refund.

CREATE TABLE "fee_student_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"source_module" text DEFAULT 'fees' NOT NULL,
	"source_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoiced_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "fee_student_charges_amount" CHECK (amount_paise > 0),
	CONSTRAINT "fee_student_charges_label" CHECK (length(trim(label)) > 0),
	CONSTRAINT "fee_student_charges_cancel" CHECK ((cancelled_at is null) = (cancel_reason is null) and (cancel_reason is null or length(trim(cancel_reason)) >= 5))
);
--> statement-breakpoint
ALTER TABLE "fee_student_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_student_charges" ADD CONSTRAINT "fee_student_charges_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_student_charges" ADD CONSTRAINT "fee_student_charges_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_student_charges" ADD CONSTRAINT "fee_student_charges_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_student_charges" ADD CONSTRAINT "fee_student_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_student_charges_student" ON "fee_student_charges" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_student_charges_source" ON "fee_student_charges" USING btree ("source_module","source_id") WHERE source_id is not null and cancelled_at is null;--> statement-breakpoint
CREATE POLICY "fee_student_charges_tenant_isolation" ON "fee_student_charges" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fee_student_charge_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a charge is cancelled, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_student_charge_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'a charge is on a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_student_charge_student';
    END IF;
    NEW.invoiced_at := NULL;
    NEW.cancelled_at := NULL;
    NEW.cancel_reason := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['invoiced_at', 'cancelled_at', 'cancel_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['invoiced_at', 'cancelled_at', 'cancel_reason'])
     OR (OLD.invoiced_at IS NOT NULL AND NEW.invoiced_at IS DISTINCT FROM OLD.invoiced_at)
     OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a charge is fixed once raised'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_student_charge_fixed';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.invoiced_at IS NOT NULL THEN
    RAISE EXCEPTION 'that charge is on an invoice already; waive or refund it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_student_charge_invoiced';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND NEW.invoiced_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled charge is not invoiced'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_student_charge_fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fee_student_charges_guard" BEFORE INSERT OR UPDATE OR DELETE ON "fee_student_charges"
  FOR EACH ROW EXECUTE FUNCTION fee_student_charge_guard();
