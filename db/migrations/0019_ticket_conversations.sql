-- 0019_ticket_conversations.sql
-- A conversation on every ticket: messages, internal notes, drafts and the
-- activity worth showing beside them. docs/conversation.md is the
-- specification, and the invariants below carry its IDs (C1 to C12).
--
-- Until now a ticket had an event log and an outbound mail queue and no
-- conversation. Replies lived in `ticket_events` payloads, notes had an event
-- kind nothing wrote, and attachments were filenames in a jsonb column. That
-- audits an agent well and serves two people working a ticket badly, and every
-- feature that needs turns, a summary or a step the user is on had nowhere to
-- put them.
--
-- This is not a comments table. It is an append-only log of communication with
-- a total order, an author derived from the authenticated identity, a
-- visibility, provenance for anything a model wrote, and a pointer into the
-- audit log for every entry. Mutable state (delivery status, the lock) lives
-- elsewhere and points at it.

-- ---------------------------------------------------------------------------
-- Keys for the composite foreign keys below (C3).
--
-- A message's tenant is proved by the database, not only by the query that
-- wrote it: each foreign key carries `business_id`, so a row cannot point at a
-- ticket, a requester or an outbound message in another tenant however it was
-- written. That needs `(id, business_id)` to be unique on each target. `id` is
-- already the primary key, so these add no restriction, only an index.
-- ---------------------------------------------------------------------------

alter table tickets
  add constraint tickets_id_business_key unique (id, business_id);
alter table requesters
  add constraint requesters_id_business_key unique (id, business_id);
alter table outbound_messages
  add constraint outbound_messages_id_business_key unique (id, business_id);

-- ---------------------------------------------------------------------------
-- Conversations.
-- ---------------------------------------------------------------------------

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  ticket_id       uuid not null,

  -- Which thread on the ticket. One `primary` per ticket, holding the
  -- exchange with the requester and the desk's notes on it. Side threads (a
  -- vendor, a second contact) are further kinds, added with their writer.
  kind            text not null default 'primary',

  -- `open`, or `locked` with a reason. A locked conversation takes no more
  -- messages (C10). Merging a ticket locks its conversations.
  status          text not null default 'open',
  locked_reason   text,

  -- The last sequence number handed out, and when. The append is the only
  -- writer of either, under this row's lock (C2, C12).
  last_seq        int not null default 0,
  last_message_at timestamptz,

  created_at      timestamptz not null default now(),

  foreign key (ticket_id, business_id)
    references tickets (id, business_id) on delete cascade,
  unique (id, business_id),

  constraint conversations_kind check (kind in ('primary')),
  constraint conversations_status check (status in ('open', 'locked')),
  constraint conversations_lock_reason check ((status = 'locked') = (locked_reason is not null)),
  constraint conversations_last_seq check (last_seq >= 0)
);

create unique index conversations_one_primary
  on conversations (ticket_id) where kind = 'primary';
create index on conversations (business_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- Messages.
-- ---------------------------------------------------------------------------

create table conversation_messages (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null,
  conversation_id     uuid not null,

  -- The order (C2). 1, 2, 3 ... per conversation, no gaps, no repeats,
  -- allocated under the conversation's row lock. Nothing orders by a
  -- timestamp: two clocks, or two writes in the same millisecond, cannot
  -- reorder a conversation.
  seq                 int not null,

  -- `message`: words for a person. `draft`: words proposed and not sent, which
  -- a person or a rule may later send as a new message derived from it.
  -- `event`: activity shown in the conversation, pointing at the audit event
  -- it shows (a status change, an action the agent took).
  kind                text not null,

  -- `public` reaches the requester. `internal` is for the desk (C5).
  visibility          text not null,

  -- Who wrote it (C4). Derived from the context by the repository, never
  -- taken from the caller. `staff` is a person at the desk, `ai` is the agent.
  author_kind         text not null,
  author_user_id      uuid references users(id),
  author_requester_id uuid,

  -- How it arrived or went out: the intake channels, plus the console, the
  -- portal and `internal` for what never left the desk.
  channel             text not null,

  content_type        text not null default 'text/plain',
  body                text not null,
  -- True when secrets were masked before the row was written (C11).
  secrets_scrubbed    boolean not null default false,

  -- One message per key per tenant (C8). Every writer supplies one, so a
  -- retried request, a redelivered webhook and a double-clicked button each
  -- produce one row.
  idempotency_key     text not null,

  -- The channel's own id for an inbound message, such as an email Message-ID.
  source_message_id   text,
  -- When the channel says it happened (an email's Date header). Informational
  -- only: it never decides the order.
  occurred_at         timestamptz,

  -- The message this one was made from, such as the draft a person sent (C6).
  -- Same conversation, enforced below.
  derived_from_id     uuid,

  -- The delivery row for a public message that went out. Delivery status
  -- changes, so it stays on `outbound_messages` and this row stays immutable.
  outbound_id         uuid,

  -- The audit event this append wrote (C7), and for `kind = 'event'`, the
  -- audit event it shows.
  event_id            bigint not null references ticket_events(id) on delete cascade,
  about_event_id      bigint references ticket_events(id) on delete cascade,

  -- Provenance for anything the agent wrote (C6).
  ai_model            text,
  ai_prompt_version   text,
  ai_config_version   int,
  -- What the words were grounded on: retrieved chunks, documents.
  ai_sources          jsonb,

  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),

  -- Every reference into the tenant cascades. Purging a tenant deletes the
  -- requesters, the outbound rows and the audit events as well as the
  -- conversations, in whatever order Postgres chooses, and a plain foreign key
  -- would refuse whichever went first. Outside a purge a cascade reaches the
  -- append-only guard below and is refused there (C1), so deleting a
  -- requester who wrote a message fails as it should, with a hint saying why.
  foreign key (conversation_id, business_id)
    references conversations (id, business_id) on delete cascade,
  foreign key (author_requester_id, business_id)
    references requesters (id, business_id) on delete cascade,
  foreign key (outbound_id, business_id)
    references outbound_messages (id, business_id) on delete cascade,
  foreign key (derived_from_id, conversation_id)
    references conversation_messages (id, conversation_id) on delete cascade,

  unique (conversation_id, seq),
  unique (id, business_id),
  unique (id, conversation_id),

  constraint conversation_messages_seq check (seq > 0),
  constraint conversation_messages_kind check (kind in ('message', 'draft', 'event')),
  constraint conversation_messages_visibility check (visibility in ('public', 'internal')),
  constraint conversation_messages_author_kind
    check (author_kind in ('requester', 'staff', 'ai', 'system')),
  constraint conversation_messages_channel
    check (channel in ('email', 'slack', 'widget', 'phone', 'api', 'portal', 'console', 'internal')),

  -- The shape of each author (C4, C5). A requester writes public messages
  -- only; a person at the desk is named; the agent and the system are not
  -- people and name nobody.
  constraint conversation_messages_requester_shape check (
    author_kind <> 'requester'
    or (author_requester_id is not null and author_user_id is null
        and visibility = 'public' and kind = 'message')),
  constraint conversation_messages_staff_shape check (
    author_kind <> 'staff'
    or (author_user_id is not null and author_requester_id is null)),
  constraint conversation_messages_machine_shape check (
    author_kind not in ('ai', 'system')
    or (author_user_id is null and author_requester_id is null)),

  -- Every row the agent wrote names its model, and no other row carries
  -- provenance (C6).
  constraint conversation_messages_ai_provenance check (
    (author_kind = 'ai') = (ai_model is not null)),
  constraint conversation_messages_provenance_only_ai check (
    author_kind = 'ai'
    or (ai_prompt_version is null and ai_config_version is null and ai_sources is null)),

  -- A draft was never sent, so it cannot be public.
  constraint conversation_messages_draft_internal check (kind <> 'draft' or visibility = 'internal'),
  -- An event shows an audit event, and only an event does.
  constraint conversation_messages_event_shape check ((kind = 'event') = (about_event_id is not null)),
  -- Only a public message from the desk goes out.
  constraint conversation_messages_outbound_shape check (
    outbound_id is null
    or (kind = 'message' and visibility = 'public' and author_kind in ('staff', 'ai'))),
  -- Only an inbound message has a channel id of its own.
  constraint conversation_messages_source_shape check (
    source_message_id is null or author_kind = 'requester')
);

create unique index conversation_messages_idempotency
  on conversation_messages (business_id, idempotency_key);
create index on conversation_messages (business_id, created_at desc);
create index on conversation_messages (outbound_id) where outbound_id is not null;

-- ---------------------------------------------------------------------------
-- Attachments (C9).
--
-- Part of the message: written in its transaction, same tenant, same
-- visibility. `storage_key` is null until attachments are stored. Intake has
-- only ever captured names, and storage is its own piece of work.
-- ---------------------------------------------------------------------------

create table conversation_attachments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  message_id    uuid not null,
  -- The order they were attached in, from 0. The attachments of one message
  -- share a transaction's timestamp and have random ids, so without this
  -- their order would be whatever the index returned.
  position      int not null,
  filename      text not null,
  content_type  text,
  size_bytes    bigint,
  storage_key   text,
  sha256        text,
  created_at    timestamptz not null default now(),

  foreign key (message_id, business_id)
    references conversation_messages (id, business_id) on delete cascade,
  unique (message_id, position),

  constraint conversation_attachments_position check (position >= 0),
  constraint conversation_attachments_size check (size_bytes is null or size_bytes >= 0)
);

-- ---------------------------------------------------------------------------
-- Append-only (C1).
--
-- The same guard as `audit_events`: no update ever, and no delete except while
-- a whole tenant is purged (0011). A correction is a new message.
-- ---------------------------------------------------------------------------

create trigger conversation_messages_no_update
  before update on conversation_messages
  for each row execute function refuse_mutation();
create trigger conversation_messages_no_delete
  before delete on conversation_messages
  for each row execute function refuse_mutation();

create trigger conversation_attachments_no_update
  before update on conversation_attachments
  for each row execute function refuse_mutation();
create trigger conversation_attachments_no_delete
  before delete on conversation_attachments
  for each row execute function refuse_mutation();
