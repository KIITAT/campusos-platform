-- A library fine is income, and not tuition. Applied by the host at install
-- time, in this order.
--
-- Its own account rather than a line in "Tuition and fees": an institution
-- asking what it charged students for teaching should not be reading a number
-- with overdue books in it.
--
-- No transaction wrapper here on purpose. Postgres will not let a new enum
-- value be used in the transaction that adds it, and the seeding of the
-- account itself happens later, from the application.

ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'fine_income';
