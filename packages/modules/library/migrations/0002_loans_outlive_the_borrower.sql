-- DATA-09 (NEW-03). Deleting a borrower used to delete their loans, and with
-- them the fines that settle into the books (api/posting.ts), because the
-- foreign key to users cascaded. It becomes NO ACTION: a borrower with loans
-- is erased, not deleted. Offboarding an institution still removes everything,
-- in one statement, with NO ACTION checked at its end.
--
-- Found by table, column and referenced table, not by name. Pre-flight: no
-- orphans, and exactly one constraint found. Rollback: a later migration
-- re-adding ON DELETE CASCADE the same way.

DO $$
DECLARE
  fk record;
  found integer := 0;
  orphans bigint;
BEGIN
  FOR fk IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class r ON r.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND r.relname = 'users'
       AND t.relname = 'library_loans'
       AND a.attname = 'borrower_id'
       AND t.relnamespace = 'public'::regnamespace
  LOOP
    found := found + 1;
    SELECT count(*) INTO orphans FROM library_loans l
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.borrower_id);
    IF orphans > 0 THEN
      RAISE EXCEPTION 'library_loans names % borrower(s) that do not exist; fix those rows first', orphans;
    END IF;
    EXECUTE format('ALTER TABLE library_loans DROP CONSTRAINT %I', fk.conname);
    EXECUTE format('ALTER TABLE library_loans ADD CONSTRAINT %I FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE NO ACTION',
      fk.conname);
  END LOOP;
  IF found <> 1 THEN
    RAISE EXCEPTION 'expected 1 foreign key from library_loans.borrower_id to users, found %', found;
  END IF;
END $$;
