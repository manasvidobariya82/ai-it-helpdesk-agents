-- 0012_outbound_email.sql
-- Make sending a reply a row rather than a function call.
--
-- `ticket.send_reply` wrote a `reply` event, stamped `first_response_at`, and
-- contacted nobody: the transport was a stub that threw if it was configured
-- and lied by omission if it was not. Ten features in section 9 of the roadmap
-- were blocked on it, and none of them could be tested honestly — delivery
-- status, retry, bounce handling and notification history are all statements
-- about a message that has to exist somewhere other than in a log line.
--
-- So the message is persisted before anything touches the network. That single
-- decision is what the rest of this migration is: a row can be retried by a
-- worker that was not the one that queued it, can be deduplicated by a unique
-- key instead of by hope, can carry a status a human is allowed to look at, and
-- survives the process that created it. A send that lives only inside an
-- `await` is lost on the first deploy mid-flight, and nobody finds out — least
-- of all the requester, who is still waiting.
--
-- What is deliberately NOT here: any notion of whether the agent was allowed to
-- send. That question is answered upstream by the risk gate and the autonomy
-- dial, and a transport that could also decide it would be a second, quieter
-- copy of the autonomy policy. This layer knows how to deliver, never whether
-- to.

create type outbound_status as enum (
  'queued',       -- waiting for a worker; `attempts > 0` means waiting to retry
  'sending',      -- claimed by a worker, in flight
  'sent',         -- the provider accepted it
  'failed',       -- attempts exhausted or refused permanently. The dead letter.
  'bounced',      -- accepted, then returned by the receiving side
  'suppressed',   -- never attempted: this address has bounced hard or complained
  'cancelled'     -- deliberately not sent (no transport configured, or a human)
);

-- One row per message we intend to put in front of a person.
create table outbound_messages (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  -- Null for a message that is not about one ticket. `on delete set null`
  -- rather than cascade: the delivery history of a mail we sent is not undone
  -- by deleting the ticket it was about.
  ticket_id     uuid references tickets(id) on delete set null,

  -- The caller's name for this message. Two calls with the same key are the
  -- same message, so a double-clicked Send button, a retried job and a
  -- redelivered webhook all produce one mail.
  idempotency_key text not null,

  kind          text not null default 'reply',   -- 'reply' | 'notification'

  to_email      text not null,
  to_name       text,
  from_email    text not null,
  from_name     text,
  -- Where a reply should go. Normally the tenant's own intake address, which is
  -- what makes an answer to our answer come back into the same tenant.
  reply_to      text,

  subject       text not null,
  body          text not null,

  -- Our RFC 5322 Message-ID, stored without the angle brackets. Generated at
  -- queue time rather than by the provider, because it is what an inbound
  -- bounce or reply quotes back at us, and it has to be resolvable to this row
  -- whatever the provider did.
  message_id    text not null,
  in_reply_to   text,
  -- `references` is a reserved word; the header it renders into is not.
  reference_ids text[] not null default '{}',

  status        outbound_status not null default 'queued',
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  -- The retry clock. A queued row whose time has come is the sweep's input, so
  -- delivery does not depend on a Redis job surviving.
  next_attempt_at timestamptz not null default now(),

  provider      text,
  provider_message_id text,
  last_error    text,

  sent_at       timestamptz,
  failed_at     timestamptz,

  bounce_kind   text,   -- 'hard' | 'soft' | 'complaint'
  bounce_detail text,

  -- Derived from the authenticated identity, never passed in: 'agent',
  -- 'system', or 'human:<user id>'.
  created_by    text not null default 'agent',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Idempotency is per tenant. Two businesses can legitimately mint the same key.
create unique index outbound_messages_idempotency
  on outbound_messages (business_id, idempotency_key);

-- A bounce names the message it is about by Message-ID, so that lookup has to
-- be unique and fast across tenants — the DSN arrives before anyone knows whose
-- it is.
create unique index outbound_messages_message_id
  on outbound_messages (message_id);

create index on outbound_messages (business_id, created_at desc);
create index on outbound_messages (ticket_id, created_at);
create index on outbound_messages (business_id, status, created_at desc);

-- The sweep's two queries. Partial, because the interesting rows are always a
-- small minority of the table.
create index outbound_messages_due
  on outbound_messages (next_attempt_at)
  where status = 'queued';
-- Rows claimed by a worker that then died. Without this they are `sending`
-- forever, which is the one status no timer ever revisits.
create index outbound_messages_stalled
  on outbound_messages (updated_at)
  where status = 'sending';

-- Every state transition, with whatever the provider said.
--
-- Separate from `ticket_events` on purpose. The ticket timeline should say "the
-- agent replied" once; it should not also say "attempt 3 of 5 deferred for 240
-- seconds after a 421". That belongs to the message, and this is where a
-- question like "how often does this provider defer us" gets answered.
create table outbound_message_events (
  id            bigserial primary key,
  outbound_id   uuid not null references outbound_messages(id) on delete cascade,
  kind          text not null,   -- 'queued' | 'attempt' | 'sent' | 'deferred' |
                                 -- 'failed' | 'bounced' | 'complained' |
                                 -- 'suppressed' | 'cancelled' | 'retried' |
                                 -- 'reclaimed'
  detail        jsonb not null default '{}'::jsonb,
  actor         text not null default 'system',
  created_at    timestamptz not null default now()
);

create index on outbound_message_events (outbound_id, created_at);
create index on outbound_message_events (kind, created_at desc);

-- Addresses we have stopped writing to.
--
-- Per tenant, deliberately: one company's departed employee is another
-- company's perfectly good customer, and a shared suppression list would leak
-- the first fact to the second company. A hard bounce or a complaint lands
-- here, and `queueOutbound` refuses the address rather than spending five
-- retries rediscovering that it is gone.
create table email_suppressions (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  email         text not null,
  reason        text not null,   -- 'hard_bounce' | 'complaint' | 'manual'
  detail        text,
  outbound_id   uuid references outbound_messages(id) on delete set null,
  created_by    text not null default 'system',
  created_at    timestamptz not null default now()
);

create unique index email_suppressions_address
  on email_suppressions (business_id, lower(email));
