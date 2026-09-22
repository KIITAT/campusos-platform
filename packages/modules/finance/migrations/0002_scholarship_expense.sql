-- An institution paying a student's fees for them is spending money, not
-- forgoing it.
--
-- A waiver is "we are not charging this" and lands in fee_waiver, against
-- revenue. A scholarship the institution funds is "we are paying this", and a
-- principal asking what the scholarship programme cost this year should not
-- have to read it out of a contra-revenue line that also holds every hardship
-- waiver the bursar granted.
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'scholarship_expense';
