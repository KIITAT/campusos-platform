-- DATA-09. Deleting a student used to delete every fee record that named
-- them -- payments, reconciled ones included, invoices, waivers, awards,
-- charges, credits, claims and demand letters -- because each foreign key to
-- users cascaded, and the row guards treat a cascade as offboarding. A receipt
-- is the institution's record of money it holds, and it outlives the person.
--
-- So these become NO ACTION: deleting a student who has any of them is
-- refused, and erasure (which anonymises in place) is the way a person goes.
-- Offboarding a whole institution still removes everything: the student and
-- the rows naming them go in the same statement, and NO ACTION is checked at
-- its end. NO ACTION rather than RESTRICT for exactly that reason -- it does
-- not depend on the order the cascades run in.
--
-- Each constraint is found by table, column and referenced table rather than
-- by name, because drizzle truncates long names. Pre-flight: no row may name a
-- student who does not exist (a pure action change validates nothing new, so
-- none is expected), and exactly eight constraints must be found.
--
-- The constraints are re-added and validated in this one transaction, which
-- holds the tables while it scans them: run it in the upgrade window.
--
-- Rollback: a later migration re-adding ON DELETE CASCADE the same way. No
-- data changes in either direction.

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
       AND r.relname = 'users'
       AND a.attname = 'student_id'
       AND t.relnamespace = 'public'::regnamespace
       AND t.relname IN ('fee_payments', 'fee_invoices', 'fee_waivers', 'fee_scholarship_awards',
                         'fee_student_charges', 'fee_drop_credits', 'fee_transfer_claims', 'fee_demand_letters')
  LOOP
    found := found + 1;
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = x.%I)',
      fk.tbl, fk.col, fk.col) INTO orphans;
    IF orphans > 0 THEN
      RAISE EXCEPTION '%.% names % student(s) that do not exist; fix those rows first', fk.tbl, fk.col, orphans;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.tbl, fk.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE NO ACTION',
      fk.tbl, fk.conname, fk.col);
  END LOOP;
  IF found <> 8 THEN
    RAISE EXCEPTION 'expected 8 fee foreign keys to users, found %', found;
  END IF;
END $$;
