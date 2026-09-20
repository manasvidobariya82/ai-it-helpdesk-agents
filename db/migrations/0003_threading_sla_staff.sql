-- 0003_threading_sla_staff.sql
-- Email threading, ticket merge, SLA clocks, assignable staff, and the
-- counters the rate limiter reads.

-- Assignable humans. `tickets.assigned_to` existed from the start with the
-- comment "null = agent owns it" but had nothing to point at.
create table staff (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  email         text not null,
  full_name     text not null,
  queue         text not null default 'tier1',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (business_id, email)
);

create index on staff (business_id, active);

alter table tickets
  add constraint tickets_assigned_to_fkey
  foreign key (assigned_to) references staff(id) on delete set null;

alter table tickets
  -- SLA clocks, stamped at triage from the tenant's policy.
  add column first_response_due_at timestamptz,
  add column resolution_due_at     timestamptz,
  -- Merge target. The merged ticket stays for audit; it stops being worked.
  add column merged_into_id        uuid references tickets(id) on delete set null,
  -- Set when the injection scanner tripped on the requester's text.
  add column injection_suspected   boolean not null default false,
  -- Set when credentials were scrubbed out of the body at intake.
  add column secrets_scrubbed      boolean not null default false;

create index on tickets (business_id, first_response_due_at)
  where first_response_at is null;
create index on tickets (business_id, resolution_due_at)
  where resolved_at is null;
create index on tickets (merged_into_id) where merged_into_id is not null;
create index on tickets (assigned_to) where assigned_to is not null;

-- Every message id we have seen for a ticket, so a reply threads onto the
-- ticket it belongs to instead of opening a new one. Populated from
-- Message-ID on the way in and In-Reply-To/References on the way back.
create table ticket_message_ids (
  message_id  text primary key,
  ticket_id   uuid not null references tickets(id) on delete cascade,
  direction   text not null default 'inbound',   -- 'inbound' | 'outbound'
  created_at  timestamptz not null default now()
);

create index on ticket_message_ids (ticket_id);

-- One row per pipeline run. The rate limiter counts these; it is a separate
-- table from llm_usage because a run that never reached the model still counts
-- against the limit.
create table agent_runs (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  requester_id  uuid references requesters(id) on delete set null,
  ticket_id     uuid references tickets(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index on agent_runs (business_id, created_at desc);
create index on agent_runs (requester_id, created_at desc);
