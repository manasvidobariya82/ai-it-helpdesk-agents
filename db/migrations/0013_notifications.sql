-- 0013_notifications.sql
-- Who gets told what, and how somebody stops it.
--
-- 0012 built a transport. This is its first set of customers: assignment,
-- SLA warning, escalation, approval and resolution notices. The machinery
-- needs almost nothing new — a notification is an `outbound_messages` row like
-- any other, with the same delivery status, retries and bounce handling — so
-- what this migration adds is the part the transport cannot answer: consent.
--
-- Two places, deliberately.
--
-- Tenant policy lives in `businesses.settings`, because "does this company send
-- assignment emails" is configuration: it belongs in the versioned snapshot, it
-- is audited, and silencing the approval notice is gated like any other change
-- that reduces human oversight.
--
-- A person's own choice lives here instead, and not in that snapshot. Rolling
-- configuration back to v14 must not resubscribe somebody who unsubscribed
-- yesterday, and a configuration version is a document people read — it should
-- not fill up with the mail preferences of forty individuals. An opt-out is a
-- fact about a person, not a setting of the tenant.

create table notification_optouts (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  -- The address, not a user or requester id: the same person may be a staff
  -- row and a requester row, and they meant "stop emailing me" either way.
  email         text not null,
  -- One of the notification kinds, or 'all'. Text rather than an enum because
  -- the set is validated in `NotificationKind` and a new kind should not need a
  -- migration to become opt-out-able.
  kind          text not null,
  reason        text,
  -- 'self' when the person used the unsubscribe link in the mail, 'console'
  -- when a member of staff did it on their behalf. Worth keeping apart: only
  -- one of those is consent.
  source        text not null default 'self',
  created_by    text not null default 'system',
  created_at    timestamptz not null default now()
);

-- Per tenant, and case-insensitive on the address, so `Alice@` and `alice@`
-- are one preference rather than two.
create unique index notification_optouts_address
  on notification_optouts (business_id, lower(email), kind);

create index on notification_optouts (business_id, created_at desc);

-- The SLA warning sweep's two queries. Partial, because a ticket that already
-- has its first response can never produce a first-response warning, and those
-- are the overwhelming majority of rows.
create index tickets_first_response_due
  on tickets (business_id, first_response_due_at)
  where first_response_at is null;

create index tickets_resolution_due
  on tickets (business_id, resolution_due_at)
  where resolved_at is null;
