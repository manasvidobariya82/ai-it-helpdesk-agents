-- 0010_intake_token_default.sql
-- Give every new tenant an intake token without anybody remembering to.
--
-- 0007 added `businesses.intake_token` and backfilled the rows that existed at
-- the time. It gave the column no default, so every business created *after*
-- that migration — by the seed, by a test fixture, by whatever provisions a
-- tenant next — starts with a null token and silently cannot receive email.
--
-- Fail-closed is the right direction for that to break in, but "the feature is
-- off until somebody notices" is not a good default when one line of DDL makes
-- it correct by construction.
--
-- A separate migration rather than an edit to 0007, because 0007 may already be
-- applied somewhere and a migration that changes after the fact is a migration
-- nobody can trust.

alter table businesses
  alter column intake_token set default encode(gen_random_bytes(24), 'hex');

-- Anything provisioned between 0007 and now.
update businesses
   set intake_token = encode(gen_random_bytes(24), 'hex')
 where intake_token is null;

-- Now that every row has one and every new row gets one, the constraint can be
-- stated rather than hoped for.
alter table businesses
  alter column intake_token set not null;
