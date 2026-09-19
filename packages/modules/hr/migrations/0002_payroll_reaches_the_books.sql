-- Payroll learns to post. Applied by the host at install time, in this order.
--
-- One table: the month's salaries actually leaving the bank, which is a
-- separate event from the payslips being generated and is the whole reason the
-- books carry a salaries-payable account. March's payroll is a cost of March
-- however late in April it is paid.
--
-- Nothing here references a finance table. The link between a payslip and its
-- journal entry is (source_module, source_ref), which is what lets the books be
-- uninstalled without a foreign key stopping it.

CREATE TABLE "hr_salary_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"period" date NOT NULL,
	"paid_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_from" text DEFAULT 'bank' NOT NULL,
	"reference" text,
	"paid_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_salary_payments_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_salary_payments_route" CHECK (paid_from in ('bank', 'cash')),
	CONSTRAINT "hr_salary_payments_period" CHECK (extract(day from period) = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_salary_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "hr_salary_payments" ADD CONSTRAINT "hr_salary_payments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_payments" ADD CONSTRAINT "hr_salary_payments_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "hr_salary_payments_once" ON "hr_salary_payments" USING btree ("institution_id","period");--> statement-breakpoint

CREATE POLICY "hr_salary_payments_tenant_isolation" ON "hr_salary_payments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- A month is paid once -------------------------------------------------------
--
-- The unique index says the same thing, and this says why: a second payment
-- for a period would post a second discharge of a liability that was only
-- accrued once, leaving salaries payable permanently negative.
--
-- Paying for a month nobody was paid for is the other half of the same
-- mistake, and is refused here rather than only in the application.
CREATE OR REPLACE FUNCTION hr_salary_payment_matches_payroll() RETURNS trigger AS $$
DECLARE
  owed bigint;
BEGIN
  SELECT COALESCE(sum(p.net_paise), 0) INTO owed
    FROM hr_payslips p
   WHERE p.institution_id = NEW.institution_id
     AND p.period = NEW.period;

  IF owed = 0 THEN
    RAISE EXCEPTION 'no payroll has been generated for %', NEW.period
      USING ERRCODE = 'check_violation',
            HINT = 'generate the payslips first; paying accrues nothing on its own';
  END IF;

  IF NEW.amount_paise <> owed THEN
    RAISE EXCEPTION 'salaries for % come to %, not %', NEW.period, owed, NEW.amount_paise
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_salary_payment_matches_payroll
  BEFORE INSERT OR UPDATE ON "hr_salary_payments"
  FOR EACH ROW EXECUTE FUNCTION hr_salary_payment_matches_payroll();
--> statement-breakpoint

-- A paid month is closed -----------------------------------------------------
--
-- Generating a payslip for a month already paid would accrue a salary nobody
-- is going to receive in that payment run, and the payment's own check would
-- then refuse to be corrected. The application refuses it first, with a
-- readable error; this is what makes it true.
CREATE OR REPLACE FUNCTION hr_payslips_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM hr_salary_payments s
     WHERE s.institution_id = NEW.institution_id AND s.period = NEW.period
  ) THEN
    RAISE EXCEPTION 'salaries for % have already been paid', NEW.period
      USING ERRCODE = 'check_violation',
            HINT = 'pay this person in the following month, or reverse the payment';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_payslips_period_open
  BEFORE INSERT ON "hr_payslips"
  FOR EACH ROW EXECUTE FUNCTION hr_payslips_period_open();
