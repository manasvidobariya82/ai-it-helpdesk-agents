-- 0008_config_versions.sql
-- Configuration history, immutably.
--
-- 0006 gave configuration changes an actor and a diff. This gives them an
-- identity. The difference matters when you replay a ticket: knowing that
-- somebody moved the VPN threshold on Friday does not tell you which number was
-- in force when ticket #1842 was decided on Thursday. A version does.
--
-- Two tables and one rule. `config_versions` is the snapshot; `audit_events`
-- is the per-field diff; and neither may ever be updated or deleted.

-- ---------------------------------------------------------------------------
-- Per-field detail on the audit row.
-- ---------------------------------------------------------------------------

alter table audit_events
  -- `resource_id` already carried the settings key, which worked but conflated
  -- "which row" with "which field of it". Splitting them means a query can ask
  -- for every change to `category_policies.vpn.confidence_threshold` across
  -- every resource, which is the question an investigation actually asks.
  add column field text,
  -- Impact summary, risk classification, the version this change produced.
  -- Deliberately loose: it is context for a human reading the row later, never
  -- something the application branches on.
  add column metadata jsonb,
  -- Set on rows that belong to a configuration version, so the audit log and
  -- the version history are the same history seen from two directions.
  add column config_version int;

create index on audit_events (business_id, field, created_at desc);
create index on audit_events (business_id, config_version);

-- Backfill: until now the settings key lived in resource_id.
update audit_events
   set field = resource_id
 where resource_type = 'business_settings' and field is null;

-- ---------------------------------------------------------------------------
-- The versions themselves.
-- ---------------------------------------------------------------------------

create table config_versions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  -- Monotonic per tenant, allocated under a row lock on `businesses`. Not a
  -- global sequence: "v17" should mean something to one customer without
  -- leaking how many changes every other customer has made.
  version      int not null,

  -- The complete settings object as of this version, not a diff. A diff chain
  -- is smaller and is wrong for this job: reconstructing v12 by replaying
  -- eleven diffs means a bug in any one of them silently rewrites history, and
  -- the whole point of the table is to be trustworthy years later.
  settings     jsonb not null,

  -- 'current' | 'superseded'. Exactly one row per tenant is 'current'.
  status       text not null default 'current',

  -- 'update' | 'rollback' | 'seed'
  source       text not null default 'update',
  -- Set when source = 'rollback': the version whose settings were restored.
  restored_from int,

  -- Denormalized like the audit actor, and for the same reason: this row has to
  -- stay readable after the user is deleted.
  created_by   uuid references users(id) on delete set null,
  actor_email  text,
  actor_role   text,
  reason       text,
  -- Which fields moved, and how they were classified. Enough to render the
  -- history without joining, while `audit_events` holds the full detail.
  summary      jsonb not null default '[]',
  request_id   text,

  created_at   timestamptz not null default now(),

  unique (business_id, version)
);

create index on config_versions (business_id, created_at desc);
create index on config_versions (business_id, version desc);

-- One current version per tenant, enforced rather than assumed.
create unique index config_versions_one_current
  on config_versions (business_id)
  where status = 'current';

-- ---------------------------------------------------------------------------
-- Immutability.
-- ---------------------------------------------------------------------------
--
-- "Append-only by convention" is a comment. This is a rule the database
-- enforces, including against the application's own connection, which is the
-- one that would otherwise do the damage — a well-meaning `update
-- audit_events set reason = ...` to tidy a typo is exactly how an audit trail
-- stops being evidence.
--
-- Superseding a version is a status change and therefore an update, so that
-- single column is allowed through explicitly: the settings, the actor, the
-- values and the timestamps stay frozen.

create or replace function refuse_mutation() returns trigger as $$
begin
  raise exception
    'The % table is append-only. Row % cannot be changed or removed.',
    tg_table_name, old.id
    using hint = 'Record a correcting entry instead of editing the history.';
end;
$$ language plpgsql;

create trigger audit_events_no_update
  before update on audit_events
  for each row execute function refuse_mutation();

create trigger audit_events_no_delete
  before delete on audit_events
  for each row execute function refuse_mutation();

create or replace function config_versions_guard() returns trigger as $$
begin
  -- Retiring a version is legitimate; rewriting one is not.
  if new.status is distinct from old.status
     and old.status = 'current'
     and new.status = 'superseded'
     and new.settings = old.settings
     and new.version = old.version
     and new.business_id = old.business_id
     and new.created_by is not distinct from old.created_by
     and new.created_at = old.created_at
     and new.reason is not distinct from old.reason
  then
    return new;
  end if;

  raise exception
    'config_versions is append-only. Version % cannot be rewritten.', old.version
    using hint = 'Create a new version, or roll back, which also creates one.';
end;
$$ language plpgsql;

create trigger config_versions_no_rewrite
  before update on config_versions
  for each row execute function config_versions_guard();

create trigger config_versions_no_delete
  before delete on config_versions
  for each row execute function refuse_mutation();

-- ---------------------------------------------------------------------------
-- Replay.
-- ---------------------------------------------------------------------------
--
-- Stamped when triage runs, so a ticket carries the configuration that decided
-- it. Without this, replaying a ticket from six weeks ago silently uses today's
-- thresholds and produces a decision nobody ever made.

alter table tickets add column config_version int;
alter table triage_shadow add column config_version int;

create index on tickets (business_id, config_version);

-- ---------------------------------------------------------------------------
-- Seed a v1 for every existing tenant, so there is no tenant whose
-- configuration has no history at all.
-- ---------------------------------------------------------------------------

insert into config_versions (business_id, version, settings, status, source, reason)
select id, 1, settings, 'current', 'seed',
       'Initial version recorded when configuration versioning was introduced'
  from businesses;

-- ---------------------------------------------------------------------------
-- Dual control for widening changes.
-- ---------------------------------------------------------------------------
--
-- A proposal that needs a second administrator before it becomes a version.
-- Only widening changes ever land here: narrowing autonomy is the brake, and a
-- brake that needs two signatures is a brake that does not work.
--
-- `base_version` is the point of the table beyond "somebody else agreed". A
-- proposal is written against a configuration the proposer read; if anything
-- else changes in the meantime, the approver would be signing off a diff that
-- no longer describes what would happen. Stale proposals are refused rather
-- than rebased.

create table config_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,

  proposed_settings  jsonb not null,
  summary            jsonb not null default '[]',
  reason             text not null,
  base_version       int not null,

  status             text not null default 'pending',
    -- 'pending' | 'applied' | 'rejected' | 'expired' | 'stale'

  requested_by       uuid references users(id) on delete set null,
  requested_by_email text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,

  decided_by         uuid references users(id) on delete set null,
  decided_by_email   text,
  decided_at         timestamptz,
  decision_reason    text,
  applied_version    int,

  -- The approver must be a different person. Enforced in the repository, where
  -- the proposer's id is known; stated here so the constraint is visible to
  -- anyone reading the schema.
  constraint decided_by_is_not_requester
    check (decided_by is null or decided_by <> requested_by)
);

create index on config_change_requests (business_id, status, created_at desc);
create index on config_change_requests (expires_at) where status = 'pending';
