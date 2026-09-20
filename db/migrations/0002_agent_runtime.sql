-- 0002_agent_runtime.sql
-- Runtime tables the agent loop needs: the approval gate, tool-call audit,
-- and model-spend accounting that is not scoped to a single ticket.

create type approval_status as enum ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed');

-- The human-in-the-loop gate. Anything above the safe tier lands here first.
create table action_requests (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  tool_name     text not null,
  args          jsonb not null,
  risk_tier     text not null,          -- 'read' | 'safe_write' | 'sensitive' | 'destructive'
  rationale     text not null,
  status        approval_status not null default 'pending',
  requested_by  text not null default 'agent',
  decided_by    text,
  decided_at    timestamptz,
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now()
);

create index on action_requests (business_id, status, created_at desc);
create index on action_requests (ticket_id);

-- Every tool invocation, approved or auto, with its outcome. Mirrors into
-- ticket_events for the timeline, but is queryable on its own for audit.
create table tool_calls (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  ticket_id     uuid references tickets(id) on delete set null,
  action_request_id uuid references action_requests(id) on delete set null,
  tool_name     text not null,
  args          jsonb not null,
  ok            boolean not null,
  result        jsonb,
  error         text,
  latency_ms    int,
  created_at    timestamptz not null default now()
);

create index on tool_calls (business_id, created_at desc);
create index on tool_calls (ticket_id, created_at);

-- Model spend, including calls with no ticket (embedding, backfills).
create table llm_usage (
  id            bigserial primary key,
  business_id   uuid references businesses(id) on delete cascade,
  ticket_id     uuid references tickets(id) on delete set null,
  purpose       text not null,          -- 'triage' | 'draft' | 'embed' | 'summarize'
  model         text not null,
  tokens_in     int not null default 0,
  tokens_out    int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd      numeric(10,6) not null default 0,
  latency_ms    int,
  ok            boolean not null default true,
  error         text,
  created_at    timestamptz not null default now()
);

-- Spend queries are range predicates on created_at, not casts to date:
-- timestamptz::date is only STABLE, so it cannot be indexed.
create index on llm_usage (business_id, created_at desc);
create index on llm_usage (created_at desc);

-- Shadow-mode ledger: what the agent WOULD have done vs. what the human did.
-- This is the table that tells you when a category is safe to automate.
create table triage_shadow (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  agent_category text not null,
  agent_priority ticket_priority not null,
  agent_confidence numeric(3,2) not null,
  agent_path     resolution_path not null,
  human_category text,
  human_priority ticket_priority,
  human_path     resolution_path,
  agreed_category boolean,
  agreed_priority boolean,
  recorded_at    timestamptz not null default now(),
  reconciled_at  timestamptz,
  unique (ticket_id)
);

create index on triage_shadow (business_id, recorded_at desc);
