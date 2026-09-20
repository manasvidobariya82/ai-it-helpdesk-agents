-- 0007_tenant_intake.sql
-- Stop intake trusting a caller-supplied business_id.
--
-- The email webhook accepted `business_id` in its JSON body and authenticated
-- the whole endpoint with one deployment-wide secret. Any integration holding
-- that secret could therefore file a ticket into any tenant — the server-to-
-- server version of `GET /tickets?business_id=123`.
--
-- The fix is the same one the console uses: the caller presents a credential,
-- and the server derives the tenant from it. The token identifies the tenant;
-- the tenant is never a parameter.

alter table businesses
  add column intake_token text unique,
  -- The address mail for this tenant arrives at, for providers that forward
  -- the envelope recipient instead of holding a per-tenant webhook URL.
  add column intake_address text unique;

create index on businesses (intake_token);

-- Existing rows get a token so a deployment mid-upgrade keeps working; it is
-- random per row rather than derived from the id, because an intake token is a
-- bearer credential and a derivable one is not a credential.
update businesses
   set intake_token = encode(gen_random_bytes(24), 'hex')
 where intake_token is null;
