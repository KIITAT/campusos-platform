-- DATA-09. Deleting a staff record used to delete what the institution paid
-- them and owes for them -- payslips, salary assignments and components,
-- withholdings, leave encashments, tax elections and the separation -- because
-- each foreign key to hr_staff cascaded. Payroll is the institution's record
-- of money paid, and it outlives the employment. (Advances, expense claims and
-- gratuity payouts were already RESTRICT.)
--
-- So these become NO ACTION: deleting a staff record that has any of them is
-- refused. Offboarding a whole institution still removes everything, in one
-- statement, with NO ACTION checked at its end -- which is why NO ACTION and
-- not RESTRICT.
--
-- Found by table, column and referenced table, not by name. Pre-flight: no
-- orphans, and exactly seven constraints found. Re-added and validated in this
-- one transaction, which holds the tables while it scans: run it in the
-- upgrade window.
--
-- Rollback: a later migration re-adding ON DELETE CASCADE the same way.

DO $$
DECLARE
  fk record;
  found integer := 0;
  orphans bigint;
BEGIN
  FOR fk IN
    SELECT c.conname, t.relname AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class r ON r.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND r.relname = 'hr_staff'
       AND a.attname = 'staff_id'
       AND t.relnamespace = 'public'::regnamespace
       AND t.relname IN ('hr_payslips', 'hr_salary_assignments', 'hr_pay_components', 'hr_salary_withholdings',
                         'hr_leave_encashments', 'hr_tax_elections', 'hr_separations')
  LOOP
    found := found + 1;
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hr_staff s WHERE s.id = x.%I)',
      fk.tbl, fk.col, fk.col) INTO orphans;
    IF orphans > 0 THEN
      RAISE EXCEPTION '%.% names % staff record(s) that do not exist; fix those rows first', fk.tbl, fk.col, orphans;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.tbl, fk.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES hr_staff(id) ON DELETE NO ACTION',
      fk.tbl, fk.conname, fk.col);
  END LOOP;
  IF found <> 7 THEN
    RAISE EXCEPTION 'expected 7 payroll foreign keys to hr_staff, found %', found;
  END IF;
END $$;
