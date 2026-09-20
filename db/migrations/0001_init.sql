-- 0001_init.sql
-- Core schema. Follows the design doc; every table is tenant-scoped.

create extension if not exists vector;
create extension if not exists pgcrypto;

create type ticket_status as enum (
  'new', 'triaged', 'awaiting_user', 'awaiting_approval',
  'in_progress', 'resolved', 'closed', 'reopened'
);

create type ticket_priority as enum ('P1', 'P2', 'P3', 'P4');

create type resolution_path as enum (
  'auto_reply', 'auto_action', 'clarify', 'escalated', 'human_only'
);

create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  type          text not null,          -- 'it_services', 'ecommerce', ...
  settings      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create table requesters (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  email         text not null,
  full_name     text,
  department    text,
  role          text,
  directory_id  text,                   -- Entra/Okta/Google object id
  vip           boolean not null default false,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (business_id, email)
);

create table assets (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  requester_id  uuid references requesters(id) on delete set null,
  asset_tag     text,
  kind          text,                   -- 'laptop', 'phone', 'vm', 'saas_seat'
  os            text,
  last_seen_at  timestamptz,
  metadata      jsonb not null default '{}'
);

create index on assets (business_id, requester_id);

create table tickets (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  external_ref    text,                 -- Jira/Freshservice key
  source          text not null,        -- 'email' | 'slack' | 'widget' | 'phone'
  source_message_id text,               -- for threading / idempotency
  requester_id    uuid references requesters(id) on delete set null,
  asset_id        uuid references assets(id) on delete set null,

  subject         text not null,
  body            text not null,
  attachments     jsonb not null default '[]',

  status          ticket_status not null default 'new',
  priority        ticket_priority,
  category        text,
  subcategory     text,

  triage_confidence numeric(3,2),       -- 0.00 - 1.00
  resolution_path   resolution_path,
  assigned_to       uuid,               -- null = agent owns it
  is_incident       boolean not null default false,
  parent_incident_id uuid references tickets(id) on delete set null,

  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  reopened_count    int not null default 0,
  clarify_count     int not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on tickets (business_id, status, priority);
create index on tickets (requester_id, created_at desc);
create index on tickets (business_id, created_at desc);
create unique index tickets_source_dedupe on tickets (source, source_message_id)
  where source_message_id is not null;   -- idempotent intake

-- Every model call, tool call, and human action lands here. Append-only:
-- "why did the agent close this?" is answered by replaying this table.
create table ticket_events (
  id            bigserial primary key,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  actor         text not null,          -- 'agent' | 'user' | 'human:<id>' | 'system'
  kind          text not null,          -- 'triage' | 'reply' | 'draft' | 'tool_call' |
                                        -- 'approval' | 'escalation' | 'status_change' |
                                        -- 'retrieval' | 'note' | 'error'
  payload       jsonb not null,
  model         text,
  tokens_in     int,
  tokens_out    int,
  cost_usd      numeric(10,6),
  latency_ms    int,
  created_at    timestamptz not null default now()
);

create index on ticket_events (ticket_id, created_at);
create index on ticket_events (kind, created_at desc);

-- Knowledge base: runbooks + resolved-ticket writebacks.
create table kb_documents (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  title         text not null,
  source_url    text,
  origin        text not null,          -- 'runbook' | 'vendor_doc' | 'resolved_ticket'
  categories    text[] not null default '{}',
  content_hash  text not null,
  created_at    timestamptz not null default now(),
  unique (business_id, content_hash)
);

create table kb_chunks (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  doc_id        uuid not null references kb_documents(id) on delete cascade,
  doc_title     text not null,
  source_url    text,
  origin        text not null,          -- 'runbook' | 'vendor_doc' | 'resolved_ticket'
  content       text not null,
  embedding     vector(1536) not null,
  categories    text[] not null default '{}',
  -- A resolved-ticket writeback supersedes the runbook it corrects. Without
  -- this you retrieve a 2024 fix for a system that changed in 2025.
  superseded_by uuid references kb_chunks(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index on kb_chunks using hnsw (embedding vector_cosine_ops);
create index on kb_chunks (business_id, origin);
create index on kb_chunks (doc_id);
