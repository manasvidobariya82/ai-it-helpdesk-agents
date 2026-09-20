-- 0020_conversation_legacy.sql
-- Where a copied message came from (D4 in docs/conversation.md).
--
-- Tickets from before the conversation existed keep their history in
-- `ticket_events`: the requester's replies and the desk's as `reply` events,
-- the agent's parked drafts as `draft` events, and the opening message on the
-- ticket row itself. D4 copies that history into the conversation, so the
-- conversation is the one place a thread is read from and the event log goes
-- back to being an audit log.
--
-- A copy says what it was copied from and claims nothing the record does not
-- hold. This column is that statement. It is null for every message written
-- through `appendMessage`, which has no way to set it, so nothing a writer or a
-- channel supplies can pass a native message off as history or the reverse.

alter table conversation_messages
  -- `from`: `ticket` (the opening message, from the ticket row), `reply` or
  -- `draft` (from the event of that kind). `event_id`: that event, or null for
  -- the ticket row. `actor`: the actor the event recorded, verbatim, or null.
  -- `inbound`: true for the requester's words, which decides the side a copy
  -- is shown on when its author could not be verified and it is `system`.
  add column legacy jsonb;

alter table conversation_messages
  -- Wrapped in coalesce because a check passes on null, and a missing key
  -- reads as null.
  add constraint conversation_messages_legacy_shape check (
    legacy is null or coalesce(
      jsonb_typeof(legacy) = 'object'
      and legacy ->> 'from' in ('ticket', 'reply', 'draft')
      and jsonb_typeof(legacy -> 'inbound') = 'boolean'
      and kind in ('message', 'draft')
      -- An event's copy names its event, and the ticket row has none.
      and ((legacy ->> 'from' = 'ticket') = (legacy ->> 'event_id' is null)),
      false)),

  -- One event, one copy, per tenant (C8, C13). The key is derived from the
  -- event, so the unique index on keys is also the guarantee that running the
  -- backfill twice writes nothing twice.
  add constraint conversation_messages_legacy_key check (
    legacy is null
    or legacy ->> 'from' = 'ticket'
    or idempotency_key = 'legacy:event:' || (legacy ->> 'event_id')),

  -- The event log recorded no prompt version or configuration version for
  -- anything, so a copy cannot carry one (C13). A draft's model is recorded,
  -- on the event's own `model` column, and is kept.
  add constraint conversation_messages_legacy_provenance check (
    legacy is null or (ai_prompt_version is null and ai_config_version is null));

-- The agent's replies from before the conversation existed are copied as
-- `system`, because the event that recorded them did not record the model and
-- C6 does not let an `ai` row go without one. They were still sent, so the
-- delivery row stays linked. The system's own outbound mail is public and
-- from the desk, which is what this rule was protecting.
alter table conversation_messages
  drop constraint conversation_messages_outbound_shape;
alter table conversation_messages
  add constraint conversation_messages_outbound_shape check (
    outbound_id is null
    or (kind = 'message' and visibility = 'public' and author_kind in ('staff', 'ai', 'system')));
