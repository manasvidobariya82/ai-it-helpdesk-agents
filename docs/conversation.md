# The ticket conversation

This page defines what a ticket's conversation is, who may write to it, and
what can never change once written. The schema is
[`0019_ticket_conversations.sql`](../db/migrations/0019_ticket_conversations.sql)
and [`0020_conversation_legacy.sql`](../db/migrations/0020_conversation_legacy.sql),
and the only writer is
[`conversations.ts`](../packages/core/src/repos/conversations.ts). Every
invariant has an ID, and the tests that pin it carry that ID in their names, so
`grep C7` finds the rule and its proof.

If this page and the code disagree, one of them has a bug.

## The rule

> **A conversation is an append-only log of communication. A message is
> written once, in order, by an author the system identified, with a
> visibility that decides who can read it. Nothing about it changes
> afterwards. What does change, such as delivery status or whether the
> conversation takes more messages, lives outside the message and points at
> it.**

This is not a comments table. A comments table answers "what did people type".
This model has to answer several more questions without being redesigned for
each one:

- Which of these words did the requester see?
- Did a person write this, or a model? If a model, which model, which prompt
  and which configuration, and what did it cite?
- Which draft became which reply, and who sent it?
- In what order did things happen, even when two writes land in the same
  millisecond?
- Was this retried webhook the same message or a new one?

---

## What is stored

### Conversations

A ticket has conversations. Today it has one, `kind = 'primary'`, which holds
the exchange with the requester and the desk's notes on it. Side threads, such
as one with a vendor, will be further kinds, added together with whatever
writes to them. The column exists so that adding one is a new value, not a new
model.

| Column | Meaning |
|---|---|
| `ticket_id` | The ticket. Not null: every conversation belongs to a ticket in the same tenant (C3). |
| `kind` | `primary`. One per ticket, enforced by a partial unique index. |
| `status`, `locked_reason` | `open`, or `locked` with a reason. A locked conversation takes no more messages (C10). |
| `last_seq`, `last_message_at` | The last sequence number handed out, and when. Only the append writes them, under this row's lock (C2, C12). |

A conversation is opened by its first message, which for a new ticket is the
requester's opening message, written by intake. Nothing else creates one
except a merge, which creates it locked, and the backfill (D4).

### Messages

| Column | Meaning |
|---|---|
| `seq` | Position in the conversation: 1, 2, 3, with no gaps and no repeats (C2). |
| `kind` | `message`: words for a person. `draft`: words proposed and not sent. `event`: activity shown in the conversation, pointing at the audit event it shows. |
| `visibility` | `public` reaches the requester. `internal` is for the desk (C5). |
| `author_kind` | `requester`, `staff` (a person at the desk), `ai` (the agent) or `system`. Derived from the context, never supplied (C4). |
| `author_user_id`, `author_requester_id` | Who, for a person or a requester. Neither for the agent or the system. |
| `channel` | How it arrived or went out: `email`, `slack`, `widget`, `phone`, `api`, `portal`, `console`, or `internal` for what never left the desk. |
| `body`, `content_type` | The words, and what they are. |
| `secrets_scrubbed` | True when secrets were masked before the row was written (C11). |
| `idempotency_key` | The writer's name for this message, unique per tenant (C8). |
| `source_message_id` | The channel's own id for an inbound message, such as an email Message-ID. |
| `occurred_at` | When the channel says it happened, such as an email's `Date`. Informational only: it never decides the order (C2). |
| `derived_from_id` | The message this one was made from, such as the draft a person sent. Same conversation (C6). |
| `outbound_id` | The delivery row for a public message that went out, from the desk, the agent or the system. |
| `event_id` | The `ticket_events` row this append wrote (C7). |
| `about_event_id` | For `kind = 'event'`: the audit event this message shows. |
| `ai_model`, `ai_prompt_version`, `ai_config_version`, `ai_sources` | Provenance, on the agent's rows and nobody else's (C6). |
| `metadata` | Channel extras: headers, thread ids, a widget's page. A reply sent from a template names it here (`template`), and a parked draft records what the agent would have done (`draft_kind`, `would_have`, `rule`). |
| `legacy` | Null, except on a copy of the record from before the conversation (D4, C13): where it came from (`ticket`, `reply` or `draft`), the event, the actor the event recorded, and whether the words were the requester's. `appendMessage` has no way to set it. |
| `created_at` | When it was recorded here. |

### Attachments

`conversation_attachments` rows belong to one message. Each has a `position`,
which is the order it was attached in, the file's name, type and size, and,
once attachments are stored, a `storage_key` and a `sha256`. The position is
stored because a message's attachments share one transaction's timestamp and
have random ids, so nothing else records their order. Intake has only ever
captured names, so the storage key is null for now (see [Not yet](#not-yet)).
A reply's attachments are kept too, which the event log never did.

---

## Authors

The author comes from the context and nothing else. This is the rule
`outbound_messages.created_by` already follows: an author the caller could name
is an author the caller could forge.

| The context | Writes as | May name a requester | Needs |
|---|---|---|---|
| A person (`humanContext`) | `staff`, with their user id | No | `ticket:update` |
| The agent (`agentContext`) | `ai`, and must name the model | No | `ticket:update` |
| The system (`systemContext`: intake, sweeps) | `system`, or `requester` when it names one | Yes | `ticket:update`, or `ticket:create` for a requester |
| The portal (`portalContext`) | `requester`, naming the requester the link belongs to | Yes | `ticket:create` |

So a person at the desk cannot write words into the requester's mouth, the
agent cannot pass its words off as a person's, and a requester's portal link
cannot write as the system. The portal does not write messages yet (see
[Not yet](#not-yet)).

## Visibility

| | `public` | `internal` |
|---|---|---|
| Who reads it | Everybody with `ticket:read`, including the portal | Only contexts with `ticket_internal:read`: every staff role and the agent, never the portal |
| Who writes it | Requesters, the desk, the agent, the system | The desk, the agent and the system, and only a context that could read it back |
| What it is | Replies, and requester messages | Notes, drafts, and internal activity |

A requester message is always public. A draft is always internal. The database
refuses anything else, whoever wrote the row.

## Drafts and provenance

A draft is words proposed and not sent. It is never edited: sending it creates
a new `message` whose `derived_from_id` points at the draft. So "the agent
drafted this, a person changed two lines and sent it" is two rows. The draft is
`ai`-authored and carries the model, and the reply is `staff`-authored and
derived from the draft. The accountable author and the origin of the words are
both on record.

An autonomous reply is a single `ai`-authored `message`. A templated reply,
such as an incident acknowledgement, is `system`-authored and names its
template in `metadata`, because no model wrote it and naming one would be
provenance for words the model never produced.

## Who writes what

Every writer goes through `appendMessage`, except the copies of the old record,
which the backfill writes (D4). Each writer's key is what makes its retries one
message (C8).

| Writer | What it writes | Author | Key |
|---|---|---|---|
| Intake, a new ticket | The opening message, with its attachments | `requester`, through the system's context | `opening:<ticket id>` |
| Intake, a reply on a thread | The requester's reply, with its attachments. A redelivered webhook writes nothing and moves nothing | `requester` | `inbound:<source>:<source message id>` |
| `ticket.send_reply` | A public reply, linked to the outbound row that delivers it | `ai` naming its model, `system` naming its template, or `staff` | The outbound row's own key |
| The pipeline, when it may not send | A draft, internal, with what the agent would have done | `ai`, or `system` for a template | `draft:<ticket id>:<sha-256 of the words>` |
| The console, a note | An internal note | `staff` | `note:<form id>` |
| The console, a reply | A reply, or a draft sent, derived from the draft | `staff` | `console:<form id>`, or the outbound key |
| The backfill, and the first write | Copies of the record from before the conversation | As the record says (C13) | `opening:<ticket id>`, `legacy:event:<event id>` |

`ticket.send_reply` settles who wrote the words before it queues anything, and
refuses the agent's reply if it does not say, so a reply the conversation would
refuse is never sent. The outbound row and the message share a key, so a call
that failed between the two is finished by its retry.

Nothing writes a `reply` or a `draft` event any more. `appendEvent` refuses
both, because a new one would be stranded: the backfill copies the record in
order and will not copy anything after something later than itself (C2).

## Reading a conversation

`threadFor` is the one reader. It returns the messages in `seq` order, with
two things every reader wants: `from`, which is the requester's side or the
desk's, including for a copy whose author could only be `system`, and `at`,
which is a copy's record time and otherwise when the message was written here.
Nobody reading a thread has to know whether the ticket is older than the
conversation.

| Reader | What it gets |
|---|---|
| The console's ticket page | Everything, including notes and drafts. The draft offered for review is the latest one no reply was derived from |
| The portal | Public messages only, because its context lacks `ticket_internal:read` (C5) |
| The API, `?include=messages` | What the key's role may read |
| The knowledge-base writeback | Public messages and drafts, never internal notes: the entry it writes is retrieved into replies to other requesters |

The follow-up sweep still reads the event log, where a requester's message
leaves a `message` event with the actor `user`.

## The audit log

Every append writes one `ticket_events` row of kind `message`, in the same
transaction, and the message's `event_id` points at it. Its payload names the
message, the conversation, the `seq`, the kind, the visibility, the author kind
and the channel. It carries no body, so the words are stored in one place.

The timeline therefore interleaves messages with everything else that
happened, in one order, and a replay can count them. The conversation's own
order is `seq`, and the two agree because both are written under the same
lock. A copy's event is the system's, written when the copy was made, and its
payload says what it was copied from, so a replay does not count it as a second
response. The model call behind an `ai` message is on its event's own `model`,
`cost_usd` and `latency_ms` columns, as every other model call's is.

---

## Invariants

| ID | Invariant |
|---|---|
| C1 | **Append-only.** A message and its attachments are never updated and never deleted, except when a whole tenant is purged. The database refuses both. A correction is a new message. |
| C2 | **Total order.** A conversation's messages are ordered by `seq`: 1 to n, with no gaps and no repeats, whatever the concurrency. `seq` is taken under the conversation's row lock, in the transaction that writes the message, so a rolled-back append leaves no gap. No timestamp decides the order. |
| C3 | **One tenant.** A conversation, its ticket, its messages, their attachments, the requester who wrote one and the outbound row that delivered one all belong to one business. Composite foreign keys enforce this, not only the queries. |
| C4 | **Identified authors.** The author is derived from the context, as in [Authors](#authors). A person cannot write as a requester, the agent cannot write as anybody but itself, and the portal cannot write as the system. |
| C5 | **Visibility.** Internal messages are readable only with `ticket_internal:read`, and writable only by a context that holds it. The portal never sees one. A requester's message is public and a draft is internal. |
| C6 | **Provenance.** Every `ai`-authored row names its model, and no other row carries provenance. `derived_from_id` points at an earlier message in the same conversation. |
| C7 | **Audit linkage.** Every append writes exactly one `message` event in the same transaction, and the message points at it. If the event cannot be written, neither is the message. |
| C8 | **Idempotency.** A key names one message per tenant. A retry returns the original and writes nothing, including no second audit event. The same key used for a different message is refused. |
| C9 | **Attachments are part of the message.** They are written in its transaction, belong to its tenant, inherit its visibility, and cannot be added later. |
| C10 | **Locked means closed to writes.** A locked conversation takes no appends, and neither does a merged ticket. Merging a ticket locks its conversation, and the lock wins any race with a first append. |
| C11 | **Secrets.** A requester's message is scrubbed for secrets before it is stored, as the ticket body is at intake. |
| C12 | **State is derived.** Whose turn it is, the counts, and the last public activity are folded from the messages (`conversationState`). Only `last_seq` and `last_message_at` are stored, and only the append writes them. |
| C13 | **A copy is its record, and only its record.** A message copied from before the conversation carries `legacy`, which `appendMessage` cannot set, and the key its record gives it, which the database checks. It names an author only when the tenant can vouch for them, carries no provenance the record did not hold, and is dated by its record. Each record is copied once, in the record's order, and never after anything later than itself. A ticket that cannot be copied whole is not copied at all. |

## Which tests pin what

| ID | Tests |
|---|---|
| C1 | `conversation.integration` "C1": update and delete refused, a requester who wrote a message cannot be deleted, and a purge succeeds whatever the messages point at |
| C2 | `conversation.integration` "C2": twenty concurrent appends get the next twenty numbers; a failed append leaves no gap; `occurred_at` does not reorder |
| C3 | `conversation.integration` "C3": a foreign requester, outbound row and derived message are refused by the database; `isolation.test` "conversations" |
| C4 | `conversation.integration` "C4": each context's author, and the forgeries refused |
| C5 | `conversation.integration` "C5": the portal reads public only, cannot write internal, and the shape checks |
| C6 | `conversation.integration` "C6": the model required, provenance refused on others, a draft sent by a person, and a derived message from another conversation refused |
| C7 | `conversation.integration` "C7": one event per append, and a failed event rolls the message back |
| C8 | `conversation.integration` "C8": a retry, concurrent retries, and a reused key |
| C9 | `conversation.integration` "C9": attachments written and read with the message, in the order attached, and internal with it |
| C10 | `conversation.integration` "C10": a merge locks the conversation, a ticket merged before it had one refuses, and the backfill opens that one locked |
| C11 | `conversation.integration` "C11": a requester's password is masked; `conversation-legacy.test` "C11 C13": a copied opening message is scrubbed again |
| C12 | `conversation.test`: `conversationState`; `conversation.integration` "C12": `last_seq` matches |
| C13 | `conversation-legacy.test`: what each kind of record becomes, who it may name, what is skipped and what is refused; `conversation.integration` "D4": a ticket copied as its record says, the portal's parity with what it showed before, once however many runs, a dry run, the refusals, and the database's checks on a copy's key and provenance |
| Writers | `conversation.integration` "D4 the first write" and "intake writes to the conversation"; `pipeline.integration`: the agent's reply and its provenance, a parked draft and a person sending it, a templated reply, and the refusals before anything is queued; `followup.integration` |

---

## Decisions

### D4: What happens to a thread from before the conversation? (decided 2026-09-19)

**Decided: it is copied into the conversation.** The conversation is then the
one place a thread is read from, and no reader has to know how old a ticket is.
The alternative was a reader that merged the event log with the conversation.
Every reader would have kept two sources of the same words, and two orders to
reconcile, for as long as old tickets exist.

**What is copied.** The opening words, from the ticket row. Every `reply` event,
public: the requester's when the event says `inbound`, the desk's otherwise.
Every `draft` event, internal. Nothing else: notes, status changes and tool
calls are the audit log and stay there. A merge's copy of another ticket's
event is skipped, because it is copied on the ticket it came from. A second
event recording the same outbound row is one message, because it was one
email.

**What a copy claims (C13).** Only what the record holds.

- A requester is named when the event names one in this tenant, and a person
  when the actor is `human:<id>` and that user is a member here.
- The agent's replies are copied as `system`. Their events never recorded the
  model, and C6 does not let an `ai` row go without one. 0020 lets a
  `system`-authored public message keep its delivery row for this.
- The agent's drafts recorded their model on the event, so they are `ai` with
  that model, and with no prompt or configuration version, which nothing
  recorded. The database refuses a copy with either.
- Where nothing can be vouched for, the author is `system`, and `legacy.inbound`
  still says whose side the words were on.

A copy is dated by its record (`occurred_at`), keyed by it (`opening:<ticket
id>`, `legacy:event:<event id>`, checked by the database), and marked as a copy
(`legacy`).

**When.** Two ways, one implementation:

- `npm run conversations:backfill` copies every ticket. It is safe to run any
  number of times and while traffic flows, `--dry-run` reports without writing,
  and a refused ticket is listed and fails the exit code.
- The first write to a conversation copies the ticket's record before itself.
  Without this, a requester replying to an old ticket before anybody ran the
  backfill would put a newer message in the conversation. The backfill would
  then refuse that ticket for good (C2), and its history could never be copied.
  With it, no order of deploy, backfill and traffic strands a ticket.

**Refusals.** A ticket is refused, and left exactly as it was, when its record
is missing something that cannot be guessed, such as the channel an inbound
reply arrived by. It is also refused when a record's key belongs to another
conversation, or when a record is older than something already in the
conversation. The last one can only happen if an old writer ran after the
switch, which `appendEvent` now prevents. On a first write, a refusal does not
stop the write: the message is written, and a `conversation_history` note on the
timeline says why the history is missing.

**Deploying it.** Migrate (0019, 0020), deploy, then run the backfill: a dry run
first, then the run. On the development database the dry run reports 10 tickets,
10 opening messages to copy, and nothing refused.

---

## Not yet

Each of these fits the model as it stands. None needs a change to what is
above.

- **Writes from the requester's side of the portal and the API.** The portal
  shows the conversation and has no reply form, and the REST API reads messages
  (`?include=messages`) and does not take them. Both would write as the
  requester through `appendMessage`. The portal has to check that the requester
  its link names owns the ticket, as it does for everything it shows.
- **Stored attachments.** Upload, storage, download and scanning. The row has
  the columns and the key is null until then.
- **A merged ticket's history on the survivor.** The survivor can list the
  locked conversations of tickets merged into it through `merged_into_id`. The
  console does not yet do so.
- **Side conversations** (`kind` other than `primary`), and a conversation that
  starts before its ticket, such as a chat. The second means allowing
  `ticket_id` to be null, which needs a rule for C7 when there is no ticket
  log.
- **Redaction.** Erasing a message a person should never have sent, or a
  requester's personal data, needs a designed operation. It cannot be an
  update (C1). Until then, deleting a requester who wrote a message is refused
  by the append-only guard, and deleting a user who wrote one is refused by its
  foreign key. Both are the safe failure.
- **Conversation UI and AI behaviour.** Built on this, not into it.
