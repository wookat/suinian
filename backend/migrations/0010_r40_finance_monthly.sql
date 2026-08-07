-- R40: expense/income notes carry an amount + currency; reports gain a period
-- (week|month) so weekly_reports can also store monthly reports.
ALTER TABLE notes ADD COLUMN amount REAL;
ALTER TABLE notes ADD COLUMN currency TEXT;
ALTER TABLE weekly_reports ADD COLUMN period TEXT NOT NULL DEFAULT 'week';
