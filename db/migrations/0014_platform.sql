-- 0014_platform.sql
-- Two things this deployment cannot currently be handed to anybody without.
--
-- **Is it alive?** There are now three sweeps, a delivery queue with a
-- dead-letter list, and a worker whose silence is indistinguishable from
-- health. Nothing outside the process can tell the difference between "idle"
-- and "stopped four hours ago", which is the state every outage starts in.
--
-- **Can anything talk to it?** One authenticated route exists — the intake
-- webhook — and it only accepts mail. A platform with no read API is a platform
-- with exactly one client, and that client is this repository.
--
-- Both tables below are deployment-wide rather than per tenant, with one
-- exception: an API key belongs to a tenant, because the whole point of it is
-- that the tenant comes from the credential and never from the request.

-- One row per running process. Deployment-wide on purpose: "is the worker up"
-- is not a question about a tenant, and scoping it to one would mean a health
-- check needed a tenant to ask about.
create table worker_heartbeats (
  -- Stable per process role rather than per process, so a restart updates the
  -- row instead of accumulating one per boot. A deployment running two workers
  -- sets distinct ids.
  id            text primary key,
  kind          text not null,              -- 'worker' | 'web' | 'cron'
  hostname      text,
  pid           int,
  version       text,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Whatever the process wants the health page to show: which sweeps it runs,
  -- the mode it booted in, the transport it is configured for. Never branched
  -- on by the health check itself.
  detail        jsonb not null default '{}'::jsonb
);

create index on worker_heartbeats (last_seen_at desc);

-- Inbound API credentials.
--
-- Same shape as sessions, for the same reasons: only the hash is stored, so a
-- database dump is not a set of working keys, and revocation is a column rather
-- than a hope that the holder deletes it.
--
-- The role is the key's authority, resolved through the same
-- `ROLE_PERMISSIONS` table the console uses. A key is therefore never more
-- capable than a person with that role, and `grantableRoles` stops an admin
-- minting a key more powerful than the admin.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  -- The first few characters of the token, so a person can tell two keys apart
  -- in a list without the list containing anything usable.
  token_prefix  text not null,
  role          text not null default 'viewer',
  created_by    text not null,
  last_used_at  timestamptz,
  request_count bigint not null default 0,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index on api_keys (business_id, created_at desc);
-- The lookup on every request: hash match, not revoked.
create index api_keys_active on api_keys (token_hash) where revoked_at is null;

-- One row per API request.
--
-- It does two jobs, which is why it is a table rather than a counter in Redis.
-- The rate limiter counts rows in a window, and the same rows answer "what has
-- this key been doing" — a question about a credential somebody else holds,
-- which nothing else in this schema could answer.
create table api_requests (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  api_key_id    uuid references api_keys(id) on delete set null,
  method        text not null,
  path          text not null,
  status        int not null,
  latency_ms    int,
  ip            text,
  created_at    timestamptz not null default now()
);

-- The rate-limit query: one key, one minute.
create index api_requests_key_window on api_requests (api_key_id, created_at desc);
create index on api_requests (business_id, created_at desc);
