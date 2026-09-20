-- 0016_tenant_scoped_message_ids.sql
-- Two uniqueness rules that were deployment-wide and had to be per tenant.
--
-- **Intake deduplication.** `tickets_source_dedupe` was unique on
-- (source, source_message_id) across every tenant. One email copied to two
-- tenants' support addresses carries one Message-ID, so the second tenant's
-- insert hit the first tenant's row, the tenant-scoped lookup that follows
-- found nothing, and intake threw — a 500 that the provider retries for ever.
-- The REST API made it worse: `external_id` is chosen by the client, "INC-1001"
-- is a perfectly ordinary choice, and whichever tenant used it first locked it
-- for everybody else. The different answers (201 against 500) also told one
-- tenant which ids another had used.
--
-- **Threading.** `ticket_message_ids` was keyed on message_id alone, with the
-- same result one table over: the second tenant's row was dropped by
-- `on conflict do nothing`, and a reply to that email could never thread there.
-- The table now carries the tenant itself, so the key can include it.

drop index tickets_source_dedupe;
create unique index tickets_source_dedupe
  on tickets (business_id, source, source_message_id)
  where source_message_id is not null;   -- idempotent intake, per tenant

alter table ticket_message_ids add column business_id uuid;

update ticket_message_ids m
   set business_id = t.business_id
  from tickets t
 where t.id = m.ticket_id;

alter table ticket_message_ids
  alter column business_id set not null,
  add constraint ticket_message_ids_business_fk
    foreign key (business_id) references businesses(id) on delete cascade,
  drop constraint ticket_message_ids_pkey,
  add primary key (business_id, message_id);
