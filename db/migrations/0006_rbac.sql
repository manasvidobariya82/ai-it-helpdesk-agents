-- 0006_rbac.sql
-- Identity, roles and the audit log that makes an actor mean something.
--
-- Until now every console write was attributed to the string `human:console`.
-- That is not an actor: it cannot be revoked, scoped to a tenant, or asked
-- about afterwards. This migration replaces it with a real subject, and adds
-- the table that records what that subject changed.

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  full_name      text not null,
  -- scrypt, stored as `scrypt$N$r$p$salt$hash`. Null means the account cannot
  -- sign in with a password yet (invited, or SSO-only later).
  password_hash  text,
  -- Platform administration, deliberately NOT a role in `memberships`: it is
  -- not scoped to a tenant, and conflating the two is how a tenant admin ends
  -- up able to read another tenant.
  is_super_admin boolean not null default false,
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now()
);

create index on users (lower(email));

-- One row per (user, tenant). A user with no membership for a business has no
-- access to it, and there is no global fallback role.
create table memberships (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  role         text not null,
  created_at   timestamptz not null default now(),
  unique (user_id, business_id)
);

create index on memberships (business_id, role);

-- Sessions are server-side so they can be revoked. The cookie carries an
-- opaque token; only its hash is stored, so a database leak is not a set of
-- usable sessions.
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  user_id       uuid not null references users(id) on delete cascade,
  -- The tenant this session is operating in. Switching tenants issues a new
  -- session rather than mutating this one, so an audit row always names the
  -- business the actor was actually in.
  business_id   uuid references businesses(id) on delete cascade,
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);

create index on sessions (user_id, created_at desc);
create index on sessions (expires_at);

-- The audit log for everything that is not a ticket event.
--
-- `ticket_events` answers "why did the agent close this ticket". It cannot
-- answer "who widened a category's autonomy on Friday afternoon", because that
-- change belongs to no ticket. Append-only, like the event log: no update, no
-- delete, and none should ever be added.
create table audit_events (
  id             bigserial primary key,
  business_id    uuid references businesses(id) on delete cascade,
  actor_id       uuid references users(id) on delete set null,
  -- Denormalized on purpose: an audit row must stay readable after the user is
  -- deleted, and must record the role as it was at the time, not as it is now.
  actor_type     text not null,          -- 'human' | 'agent' | 'system'
  actor_email    text,
  actor_role     text,
  action         text not null,          -- 'config.update', 'approval.decide', ...
  resource_type  text not null,          -- 'business_settings', 'ticket', ...
  resource_id    text,
  old_value      jsonb,
  new_value      jsonb,
  reason         text,
  -- Request correlation, so one console click can be followed across rows.
  request_id     text,
  session_id     uuid references sessions(id) on delete set null,
  ip             text,
  user_agent     text,
  created_at     timestamptz not null default now()
);

create index on audit_events (business_id, created_at desc);
create index on audit_events (actor_id, created_at desc);
create index on audit_events (resource_type, resource_id, created_at desc);
create index on audit_events (action, created_at desc);

-- Integration credentials get their own table rather than living in
-- `businesses.settings`, because settings are readable by anyone who can read
-- configuration and these must not be. Nothing reads the secret column except
-- the tool layer.
create table integration_credentials (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  provider      text not null,          -- 'entra', 'okta', 'jira', ...
  label         text not null default '',
  -- Encrypted at rest by the application; never returned by a list query.
  secret        text not null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, provider)
);

create index on integration_credentials (business_id);
