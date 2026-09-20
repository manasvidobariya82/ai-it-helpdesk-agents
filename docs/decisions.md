# Decisions worth defending

Notes on the choices in this build that were not forced, and what they buy.

## The event log is append-only

`ticket_events` has an insert and two reads. There is no update and no delete,
and there should never be one. Three months from now the question is going to
be "why did the agent close this?", and replaying an event log is the only way
to answer it honestly. Columns on `tickets` cannot do that: they show the last
state, not how it got there.

Every model call, tool call, retrieval and human action lands there with its
tokens, cost and latency.

## The decision branch is a pure function

`packages/agent-helpdesk/src/decide.ts` takes a triage result, the tenant
settings, a retrieval score and a couple of counters, and returns what should
happen. No database, no model, no clock.

That is what makes the safety argument checkable. Twenty-five tests enumerate
it, including one per mode for each rule that must never be overridable. A
policy you cannot test exhaustively is a policy you are hoping about.

## Autonomy lives in the database, not in code

Per-category autonomy and confidence thresholds sit in `businesses.settings`.
Widening autonomy should not need a deploy, and narrowing it at 4pm on a Friday
definitely should not.

The default is closed: unknown categories inherit `autonomy: off`, and a
malformed settings blob falls back to the closed default rather than to
whatever parsed.

## Two gates, and neither widens the other

`AGENT_MODE` is a property of the deployment — how far along the phase plan
this installation is. Per-category autonomy is a property of the tenant's
measured accuracy in that category. Both must open before the agent contacts a
requester. A category cleared for replies is still not cleared for actions.

## The counterfactual is always recorded

Even in shadow mode, `decide` computes what it *would* have done and writes it
to `triage_shadow`. That is the whole point of shadow mode: paired with the
human's classification from the console, it produces accuracy by confidence
bucket, which is where thresholds come from.

Thresholds picked from a number that looked reasonable are a guess wearing a
decimal point.

## Confidence alone is not enough to reply

Rule 8 refuses an unattended reply when nothing in the knowledge base supports
it, regardless of how confident triage was. A confident model with no source is
exactly the setup that produces a fluent, plausible, wrong answer — and the
requester has no way to tell.

## The whitelist is explicit and the tiers are asymmetric

Five risk tiers, and only two of them are ever unattended by default. The
`internal` tier exists because escalation was initially `safe_write`, which
meant a tenant with an empty whitelist could not escalate: the gate turned a
cautious agent into a stuck one. Handing work to a human contacts nobody and
changes nothing outside our own record, so it is never gated.

Destructive tools cannot be whitelisted at all. There is no setting for it.

## Tools are chosen by table, not by the model

`actions.ts` maps a classified category to at most one candidate tool. The
model classifies; a lookup table decides what that classification could
possibly trigger; the whitelist decides whether it runs.

The set of things the agent can do unattended is therefore enumerable by
reading one short file, which is a property you want when someone asks.

## Structured output is types-and-enums; bounds are checked after

Constrained decoding is reliable for shapes and enums. It is not where "at most
three items" belongs. Bounds are validated after parsing, and a failure throws,
which triggers the gateway's single retry with the error text attached — so the
model sees the rule it broke. A bound the model cannot see is a bound it cannot
correct.

Two failures route the ticket to a human. A malformed triage never silently
becomes a P4.

## Failure degrades to a human, never to an assumption

No credentials, cost cap hit, retrieval down, validation failed twice, tool
threw: every one of those paths ends with the ticket parked and visible, with
an error event explaining why. `runPipeline` does not throw at its caller,
because a queue that retries a decision the model already declined to make is
just spending money on the same answer.

## Supersession on knowledge base chunks

Resolved tickets are written back to the knowledge base. Without
`superseded_by`, you eventually retrieve a 2024 fix for a system that changed
in 2025 and the agent gives confident, obsolete instructions. Superseded chunks
are excluded in the query rather than filtered afterwards — a stale fix that
still ranks highly is precisely the failure mode the column exists to prevent.

## The dev embedder is deterministic, not random

`EMBEDDING_PROVIDER=hash` is hashed bag-of-words with bigrams, L2-normalised.
It gives real lexical similarity, so retrieval in development behaves like
retrieval — same input, same ranking, every run, no key and no network. It is
not semantic and the knowledge base page says so on screen.

## The tool table is the injection defence, not the prompt

Four layers guard untrusted input, and they are not equal. The agent cannot
choose a tool from free text at all: `actions.ts` maps a classified category to
at most one candidate and the whitelist decides whether it runs. A completely
successful injection still cannot reach a tool that is not in that table.

Nonce-fenced content blocks are layer three of four and the weakest. They are
in because they cost nothing, not because they work. Anyone whose injection
story is "we told the model to ignore instructions in the input" has one layer,
and it is the one that fails quietly.

When the scanner does trip, the ticket escalates rather than being dropped. The
classification came out of text that was trying to steer the agent, so the
classification is suspect too — including a reassuring one.

## Secrets at rest, PII in transit

Two different jobs that get treated as one switch and should not be.

A password pasted into a ticket body is a liability the moment the row is
written, so it is scrubbed at intake, before the insert. Nobody needs to read
it and the requester should be changing it anyway.

Names, emails and phone numbers are the helpdesk's actual job. Scrubbing them
from the database would break the product, so they are redacted in transit
instead: before a body reaches a model, and before it is embedded, where it
would otherwise be retrieved into other people's prompts forever.

What is deliberately left alone: IP and MAC addresses, hostnames, asset tags
and error codes. A naive regex reads them as PII. They are the substance of the
ticket, and removing them produces a model call that cannot answer it.

## Two SLA clocks

A P1 outage at 2am does not get to wait until nine, so its clock is calendar
time. A P4 licence request raised at 4:55pm on Friday should not breach over
the weekend, so its clock only runs in business hours. One clock cannot be both
without being wrong for one of them.

The arithmetic happens in the tenant's wall clock and converts back to an
instant afterwards, so a due date that lands on the far side of a DST change is
still the wall-clock time people expect. Clever timezone code is how you get a
P1 that breached an hour before it was raised.

## Duplicates are proposed, never merged

The duplicate query is conservative on purpose: same requester, same category,
still open, opened close together. It proposes; a human merges. Two "the
printer is broken" tickets an hour apart are very often two printers, and an
agent that silently merges them has lost one of them.

The merged ticket is closed with a pointer rather than deleted, and its events
are copied to the survivor. "Where did my ticket go" is a question the audit
trail has to be able to answer.

## Rate limits are about loops, not money

The spend cap covers cost. This covers a mail server that bounces the agent's
reply back to the agent, or a monitoring system that opens a ticket per failed
check. Those do not look like anything in the spend graph until they have been
running for hours.

The counter is its own table rather than a read of `llm_usage`, because a run
that never reached the model still counts against the limit — a loop that fails
before the model call is still a loop. Hitting the ceiling parks the ticket for
a human, which is the same degraded state as every other failure here.

## Portal links are capabilities, not logins

The console is staff-only. The portal is the requester's view of their own
tickets, and it has no login, because asking someone locked out of their
account to sign in to find out why is the oldest joke in IT support.

The link carries an HMAC of the requester id: unguessable, scoped to one
person, revocable in bulk by rotating the secret. It is a capability URL —
treat it like a password reset link, not like authentication.

The portal shows status and the replies that were already sent. It does not
show confidence, the decision rule, retrieval hits or cost. That is operator
information, and a requester reading "confidence 0.62, escalated on
no_kb_support" learns nothing good.

## Shared before separate

`core`, `llm`, `rag` and `tools` were extracted while the first agent was being
built, not after it worked. Retrofitting a shared layer out of a working
monolith is a fortnight, every time.

What is deliberately not shared with the ops agent: taxonomies, SLA semantics,
tone, and autonomy thresholds. A bad sales email is embarrassing. A bad account
deletion is a Tuesday you remember for years.

## The golden set is a file, not a table

`triage_shadow` is where labels are collected. `eval/datasets/*.jsonl` is where
they are frozen. A held-out set that any console action can silently rewrite is
not held out, and a score from six weeks ago that cannot be reproduced is not a
baseline.

Keeping it as JSONL in the repo means a label change shows up in a diff, the
set is pinned to a commit, and the split is derived from a hash of the ticket
id — so adding samples never reshuffles what was already held out. An export
never overwrites an existing sample: a label somebody reviewed by hand outranks
whatever the database says today.

## A human correction is evidence, not ground truth

The person clicking "save correction" is triaging their queue at 4pm. They are
right most of the time and wrong often enough that a golden set built by
trusting every correction measures agreement with a busy colleague rather than
correctness — and then a model that learns to agree with them scores well while
getting worse.

So the file holds both, and they are not the same thing. Exports land as
`candidate`. `npm run eval review` promotes one to `reviewed`, with a labeler
and a label version, or marks it `rejected` so nobody re-imports it next month.
Only `reviewed` samples are scored, and the dataset id is computed from that
subset alone — adding raw feedback never invalidates a pinned baseline, while
promoting or relabelling a sample does.

`--accept` refuses to run without `--labeler`. An unattributed label is one
nobody can ask about later.

## One implementation of every number

The console used to compute accuracy per confidence bucket with a `group by`,
and the phase gates were going to compute it again somewhere else. Two
implementations of the same statistic are free to drift, and the drift is
invisible until the dashboard says a threshold is safe and the gate says it is
not.

`@hd/eval` owns all of it — calibration, precision/recall, Wilson bounds,
threshold sweeps — as pure functions over `(predicted, actual, confidence)`.
The analytics page and `npm run eval` call the same code on the same rows. The
repo layer returns pairs and does no arithmetic.

## Unmeasured is not passed

Every gate has three states, not two. A safety slice nobody has labelled reports
`unmeasured`, and `unmeasured` does not pass.

The alternative — defaulting an unlabelled boolean to `false`, averaging an
empty set to zero, calling a missing number green — is how an untested claim
becomes a shipped one. It is also why the console's reclassify form offers
"not labelled" as the default on both safety labels rather than an unticked
checkbox, and why confirming a classification records nothing about flags the
reviewer was never shown.

## Thresholds come from a lower bound, not a point estimate

Four correct out of four is an accuracy of 1.00 and evidence of almost nothing.
Every rate that a decision hangs on is reported with its Wilson 95% lower
bound, and the threshold recommender only proposes a line whose *lower bound*
clears the target with at least 30 tickets above it.

Among thresholds that qualify it recommends the lowest, because among equally
defensible lines the one that automates the most tickets wins. When none
qualifies and there is enough data, it says the target is unreachable rather
than nominating the least bad dial — that is a finding about the classifier,
and moving the threshold does not fix it.

## The agent cannot make itself more autonomous

Confidence thresholds, unattended categories, action permissions, approval
requirements and routing rules are all configuration, and configuration is
changed by an authenticated human or not at all. No tool writes
`businesses.settings`; no model output is a path to widening a whitelist;
`effectiveMode` can only ever narrow.

All three thirds are enforced now. The third that used to be missing was
attribution: you could replay why the agent closed a ticket but not who widened
a category's autonomy on Friday afternoon, which made "autonomy lives in the
database so it can change without a deploy" an argument with a hole in it — the
change was cheap *and* anonymous. `audit_events` closes it: who, what, old
value, new value, when, tenant, why.

The authorization third is a permission set rather than a rule. `agentContext`
grants the pipeline eight permissions and none of them are `config:update`,
`security:update`, `agent:configure` or `action:approve`. The agent therefore
cannot widen its own autonomy or sign off its own actions, and that is a
property of the type it runs under rather than a check somewhere that could be
forgotten. `packages/core/test/authorization.test.ts` asserts the set directly,
so a future grant that quietly adds `config:update` fails the build.

## Accuracy is not the trust metric; false routing is

A `hardware` ticket classified as `software` is one misclassification. If both
route to tier1 it is zero tickets on the wrong desk, and nobody's afternoon
changed. A `software` ticket classified as `P1` and sent to oncall at 2am is
one misclassification too.

So the harness reports both, and gates on the second. The false-routing rate is
misroutes as a share of the tickets that would have been *auto-routed* —
because mistakes a human was always going to see are not the agent putting work
somewhere wrong. It is measured under the thresholds actually configured, not
under the ones the data would support: a tenant running a threshold the
evidence does not justify is exposed to it today, and scoring only the
recommendation would report them a clean zero.

Routing itself moved out of the pipeline and into `routeQueue` for this. A rule
inlined at its call site cannot be scored against a label, changed per tenant,
or included in the fingerprint that decides whether a baseline still applies.

## Some categories are never automated, whatever the number says

`security_incident` sits in `never_auto_categories` and the threshold
recommender returns `human_only` for it rather than a number. Not because it
classifies badly — it usually classifies well — but because the cost of the
rare miss is not on the same scale as the saving on the common case. That is a
judgement, and a judgement should not be expressed as a threshold somebody can
raise by 0.02 at a time until it is gone.

Offering a number for these categories would invite someone to use it, so the
report does not offer one.

## Everything that can invalidate a comparison is one hash

Model, prompt version, category taxonomy, routing rules, threshold policy and
the never-auto list are hashed into a configuration fingerprint, stored on the
baseline and on every recorded run. A comparison across two fingerprints is
reported as *a different configuration*, and the diff names the part that
moved — `routing`, `thresholds`, `taxonomy` — rather than sending somebody to
read a week of commits.

The dataset id is deliberately outside the fingerprint. "Somebody relabelled
four tickets" and "somebody swapped the model" are different problems and
deserve different sentences.

## Runs are kept, because the question gets re-sliced

The aggregates a run prints answer "is the classifier good today". They cannot
answer "which categories can safely operate at which confidence threshold",
because that needs the individual rows back — by tenant, by category, by
bucket, by prompt version — and no aggregate survives being re-sliced.

`eval_runs` and `eval_results` are insert-only. A run is a measurement of a
moment, editing one is editing the past, and the trend is the whole reason to
keep them.

## Authorization is a type, not a middleware

The obvious place to check authorization is the route: a middleware reads the
session, decides yes or no, and the handler below it does as it pleases. It is
obvious and it does not hold, because it only protects the paths somebody
remembered to route through it. The nineteenth endpoint, the background job, the
CLI script and the server action added in a hurry all reach the same database
with none of it.

So the check lives at the bottom instead. Every repository function takes a
`TenantContext` as its first argument, and `ctx.businessId` goes into the SQL
predicate rather than into an `if` above it. A cross-tenant id then matches no
row — not because a guard fired, but because the `where` clause never described
it. The failure mode of a forgotten check becomes "returns nothing" instead of
"returns everything".

`TenantContext` is a branded type, so `{ businessId: req.query.business_id }` is
not one and never will be. It comes from `contextFromSession`, or from
`agentContext` / `systemContext` / `portalContext`, and those four call sites
are the entire attack surface for "where did this tenant come from". The brand
is not security by itself; it is a compiler-level reminder that this value has a
provenance, and it makes the provenance greppable.

The cost is real: every repository signature changed, and the diff touched most
of the codebase. That was the point. The compiler enumerated every call site
that had been passing a tenant around informally, which is a list no amount of
reading would have produced reliably.

## A 403 across tenants is a 404

Inside a tenant, a missing permission is a plain 403 with the permission named
in it. The resource's existence is not the secret, and telling somebody they
need `security:update` is more useful than a blank refusal.

Across tenants it is a 404, and the id is never confirmed. "Exists but
forbidden" and "does not exist" have to be indistinguishable, or every detail
page becomes an enumeration oracle: guess a uuid, read the status code, learn
whether a competitor's ticket is real. `getTicket` returns null for a foreign id
rather than throwing, and `assertSameTenant` raises `NotFoundError`.

This is why the isolation tests assert on the shape of the refusal and not only
on the absence of data. A version of this code that threw `AuthorizationError`
for a foreign ticket id would pass "no data leaked" and still leak.

## The approval row is the authorization, not the approver's session

A manager holds `action:approve` and an admin holds `action:execute`, and they
are deliberately different grants. That raises an awkward question at the moment
a manager approves something: they are not permitted to run it, so who does?

The answer is that the approval row itself carries the authorization for that
one call. `executeTool` requires `action:execute` *unless* an `approvalId` is
present, and an approval row only exists because somebody holding
`action:approve` wrote it against those exact arguments. Treating the row as the
grant keeps the two permissions genuinely separate — a deployment can hand
approval to a team that cannot execute anything directly — without inventing a
privileged context that runs the tool on their behalf, which would be the
escalation path this split exists to prevent.

## Intake resolves its tenant from a credential, never from the payload

The inbound-email webhook accepted `business_id` in its JSON body and
authenticated the endpoint with one deployment-wide secret. That is the
server-to-server form of `GET /tickets?business_id=123`: anybody holding the
secret could file a ticket into any tenant, and a compromised integration at one
customer reached all of them.

The fix is not to validate the field. It is to remove it. `businesses` carries a
random per-tenant `intake_token`; the caller presents it, and the tenant comes
out of the row it matches. `InboundMessage` has no `business_id` to set.

The old shared secret still works on a single-tenant deployment, where it can
only mean one thing. On a multi-tenant one it is refused with a log line rather
than falling back to "the first business" — that fallback is exactly how one
company starts receiving another's mail, and it fails silently and permanently.

## A version is a snapshot, not a diff chain

`config_versions` stores the whole settings object at every version. A chain of
diffs would be smaller and is wrong for this job: reconstructing v12 by replaying
eleven diffs means a bug in any one of them silently rewrites history, and the
entire value of the table is being trustworthy years later, when the code that
wrote it is long gone.

The per-field diff still exists, in `audit_events`, one row per changed field
with both values and the reason. The two are the same history seen from two
directions — "what did the configuration look like" and "who moved this
number" — and they are written in one transaction, so there is no state where
the settings moved and the record did not.

## Immutability is a trigger, not a convention

The event log has been "append-only by convention" since the first migration,
which means append-only until somebody writes an `update`. `audit_events` and
`config_versions` now refuse updates and deletes at the database level, and the
refusal applies to the application's own connection — which is the one that
would otherwise do the damage. A well-meaning `update audit_events set reason =
...` to fix a typo is exactly how an audit trail stops being evidence.

One update is permitted: flipping a version's status from `current` to
`superseded`, with every other column unchanged. Without that exception no new
version could ever be written. The trigger checks the other columns rather than
trusting the statement.

Deleting a tenant cascades into both tables, which the guard refused — so a
customer could not be offboarded and a GDPR erasure could not be honoured. The
answer is not a weaker guard; it is `purgeBusinessUnaudited`, which sets
`hd.purge` for one transaction. An ordinary delete still fails. Editing stays
impossible in every case, because a correcting entry is always the right answer
and a rewritten row never is.

## Widening needs two people; narrowing needs none

Autonomy changes are not symmetrical, and treating them as if they were is the
mistake that makes change control actively harmful.

Widening — a lower confidence threshold, a new whitelisted tool, removing the
kill switch — is the change that can hurt somebody. It needs `security:update`,
a written reason, an explicit acknowledgement of the impact, and, where the
tenant asks for it, a second administrator.

Narrowing is the brake. Somebody who has decided the agent is misbehaving has to
be able to stop it without finding a colleague, because every second spent
looking for one is a second the agent is still answering tickets. So narrowing
takes the same permission and the same audit row, and skips every gate that
introduces delay.

`directionOf` is the function that decides which is which, and the direction of
each field is listed rather than inferred. Getting one backwards would gate the
safe direction and wave the dangerous one through, which is worse than having no
gate at all.

## The confirmation is on the server

"Show the impact, then ask them to confirm" is a dialog, and a dialog is
something a direct POST walks straight past. `updateSettings` refuses a widening
change that arrives without `acknowledgeWidening`, so the confirmation step
exists whether or not the request came from the page that renders it.

The impact sentence is generated by the same module that enforces the gate, not
by the form. A form that computes its own description of what it is about to do
will eventually describe something else.

## An approval id is not a password

The risk gate unlocked on `Boolean(ctx.approvalId)`. It checked that an approval
id was *present*, never that it was *valid* — so a rejected approval's id, an
already-executed one, one belonging to another tenant, or the literal string
"yes" all ran a destructive tool. The queue looked like a control and was one
only for callers who were not trying.

`checkApproval` asks four questions, and each one is a way that was wrong: is
the row in this tenant, is it approved rather than pending or rejected, has it
expired, and are the arguments the ones the approver actually saw. The last
matters most. Without it an approval to reset one person's password is a
capability to reset anybody's, which is the difference between a specific
authorization and a standing permission.

Expiry is checked at the point of use as well as by a sweep. A worker that is
down must not be a way to make stale approvals executable again.

## A send is a row, not a function call

`ticket.send_reply` used to write a `reply` event and contact nobody. The
transport was a stub, so a ticket could read as answered while the requester had
heard nothing — and there was no state anywhere that disagreed.

The message is now written to `outbound_messages` before anything touches the
network, and a worker owns delivery. That one decision is what the rest of the
feature is made of. A row can be claimed by a different process than the one
that queued it, retried on a clock that survives a deploy, deduplicated by a
unique key instead of by hope, and shown to a human. A send that lives only
inside an `await` has none of those properties: on a timeout the caller cannot
tell whether the person was contacted, and retrying the job either duplicates
the mail or loses it.

So nothing in a request path sends mail, and nothing in a request path is
allowed to claim it did. `send_reply` returns `queued`, never `delivered`.

## The row is the queue; Redis is a doorbell

BullMQ makes delivery prompt. It is not what makes delivery certain, and the
difference is a sweep: any message that is queued and due is picked up by the
worker whether or not its job survived. A Redis restart therefore delays a reply
by one sweep interval rather than dropping it, and `send_reply` treats a failed
enqueue as a non-event.

The same reasoning covers a message left in `sending` by a worker that died.
That is the one status no timer ever revisits, so the sweep reclaims it after
five minutes — without resetting its attempt count, because we genuinely do not
know whether the provider accepted it.

## Transient or permanent is the only distinction a transport needs

Every failure a mail provider can produce is either worth trying again or not,
and nothing else about it changes what this system does. A 421 from a greylisting
server and a 550 for a mailbox that no longer exists read almost identically in
a log line and are opposite instructions.

So `TransientDeliveryError` and `PermanentDeliveryError` are the interface, and
each provider maps its own vocabulary onto them — SMTP reply codes, Postmark's
`ErrorCode`. Anything unrecognised is transient, deliberately: being wrong in
that direction costs a few retries, and being wrong in the other means giving up
on mail that would have gone through.

A third property hangs off `Permanent`: whether the failure is a statement about
the *address* rather than about this message. `550`, `553` and Postmark's `406`
are, so they suppress the address. `552 message too large` is not — the person
still works there.

## Suppression is per tenant

A hard bounce or a complaint stops an address, and the list that records it is
scoped to one business. That is not tidiness. One company's departed employee is
another company's perfectly good customer, and a shared list would both stop mail
that should be sent and tell the second company something about the first.

Lifting a suppression is audited and requires a reason. The address is on the
list because a mail server said the mailbox is gone or a person said they did not
want our mail, and overriding either is a decision somebody may have to answer
for. A retry against a suppressed address is refused rather than implicitly
lifting it — that is how a complaint becomes a second complaint.

## A bounce is a document written by a stranger

An inbound delivery status notification quotes one of our Message-IDs back at us,
and a Message-ID is not a secret: it has travelled through other people's
infrastructure by definition. So the tenant comes from the transport that
delivered the report — an intake token, a mailbox, a per-tenant webhook
credential — and the message is resolved with that tenant in the predicate.
Without it, anybody who had ever received one of our emails could mark another
tenant's mail as bounced, or suppress an address they have no relationship with.

The parser is deliberately hard to convince. A real report declares itself in a
`Content-Type`; bare DSN fields in a body do not count unless the envelope
corroborates them, because a requester can type `Final-Recipient: rfc822;
someone@example.com` into a support request, and a parser that believed it would
be a way for anyone who can open a ticket to suppress anybody's address.

And a soft bounce is not a failure. `4.x.x` and `Action: delayed` are the far
side saying it is still trying; recording that as "the requester never got this"
would be wrong about mail that is in flight.

## An undelivered reply reopens the ticket

A resolution the requester never received is not a resolution. When a message
dead-letters or hard-bounces, the ticket gets an `error` event saying so and goes
back to `triaged`, which routes to a person — never back to the agent. The agent
has already had its turn and the outcome was that nobody heard from us.

This is the same rule the reopen path follows when a requester replies to a
closed ticket, and it exists because the alternative is a queue that looks clean
while people sit waiting for answers that bounced.

## The transport cannot widen autonomy

Nothing in the mail layer decides whether a message *should* be sent. That is the
risk gate and the autonomy dial, upstream, and a transport that could also grant
itself permission would be a second, quieter copy of the autonomy policy — the
exact thing the rest of this document is about.

What the layer adds is one refusal in the other direction: a suppressed address
makes `send_reply` fail, which parks the ticket with a human. Narrowing needs no
authorization, which is the invariant, stated again in a smaller place.

## The kill switch reaches the queue

`AGENT_MODE` and a tenant's `agent_mode_override` used to be sufficient on their
own, for an uncomfortable reason: nothing was ever sent, so nothing could be in
flight when somebody flipped them. A queue changes that. A reply decided in
`auto` and delivered ten seconds later is outbound contact that began before the
switch moved.

So the delivery loop re-checks the effective mode before an agent's message
leaves, and cancels it if autonomy has narrowed — then writes to the ticket and
puts it back in front of a person, because a resolution nobody received is not
one. A human's message is not subject to this: shadow mode is a statement about
the agent, and a person who clicked Send has already made the decision the
switch exists to withhold.

This is the invariant in a new place. Narrowing takes effect immediately and
needs no authorization; widening cannot happen here at all, because nothing in
this layer can grant permission to send.

## Notifications default on; autonomy defaults off

Every other default in this system is closed. Category autonomy starts at `off`,
the action whitelist starts empty, `never_auto_categories` starts populated. The
notification toggles start on, and the asymmetry is deliberate: the failure mode
of too much autonomy is a wrong action taken on somebody's behalf, and the
failure mode of too few notifications is a person who never finds out. Those are
not comparable.

The volume problem is real and is solved at the other end. Every staff
notification carries an unsubscribe link, deduplication collapses a repeat into
one email, and a bulk assignment produces one covering note rather than forty
pings. Turning things off centrally is the last resort rather than the default,
because a tenant-wide switch is a decision made by somebody who is not the
person receiving the mail.

## A tenant switch is configuration; a person's opt-out is not

`businesses.settings.notifications` is versioned, audited and rolled back with
everything else, because "does this company email people on assignment" is a
configuration question.

An individual saying "stop" is not. It lives in `notification_optouts`, and the
reason is one sentence: a rollback to last week's configuration must not
resubscribe somebody who unsubscribed yesterday. There is a second reason —
a configuration version is a document people read, and it should not fill up
with the mail preferences of forty individuals — but the first one on its own
settles it.

## Silencing the approval notice is a widening change

Most of the notification toggles are preferences. Two are not: the master switch,
and the approval notice.

An approval request has carried a deadline since expiry landed. If nobody is
told it exists, it expires unread, and from the ticket's point of view an
expired request is indistinguishable from a refused one — the action does not
happen and nobody decided anything. So switching that notice off makes the agent
operate with less human oversight, which is this codebase's existing definition
of widening: `security:update`, a written reason, an acknowledgement of the
impact, and a second administrator where the tenant requires one. Turning it
back on needs none of that.

The generic-sounding leaf names are why `FALSE_IS_WIDER` now accepts full dotted
paths. `notifications.enabled` is a brake; a future `something_else.enabled`
might not be, and claiming the word `enabled` globally would have quietly gated
settings nobody had thought about.

## A notification is a consequence, not a second privileged action

A manager can assign a ticket. A manager cannot execute tools — `action:execute`
is an admin permission, and that split is correct: assigning work is not the
same authority as resetting somebody's password.

But queueing mail *is* `action:execute`, so the assignment email would have
failed for exactly the people who do most of the assigning. The resolution is
that notifications are sent by the system rather than by the actor: the person
did an authorized thing, and the email is what follows from it. The ticket's
event log records who caused it.

What makes that safe is the shape of the code rather than a permission check.
`notify()` renders from a closed union of templates in `catalogue.ts`, and every
caller resolves its recipients through a tenant-scoped directory lookup — the
assignee of this ticket, the staff on this queue, the holders of
`action:approve` in this tenant. There is no path through it from arbitrary text
to an arbitrary address. That path exists exactly once, in
`ticket.send_reply`, and it is the one the autonomy dial gates.

## Warn on a share of the window, not a fixed number of minutes

"Warn 30 minutes before the SLA breaches" is useless at both ends of this
system. A P1 first-response target is fifteen minutes, so the warning would
arrive before the ticket; a P4 resolution target is three days, so it would
arrive far too late to matter.

The threshold is a percentage of each ticket's own window, defaulting to 20%: a
fifteen-minute target warns with three minutes left, a four-hour target with
forty-eight minutes, a three-day target with most of a working day. The shape is
right because the useful warning is proportional to how long the remedy takes.

Breached tickets are excluded rather than warned again. A breach is a different
fact, the queue already shows it, and an email about it would be a second
notification about something nobody can now prevent.

## The unsubscribe link works without a login, and acts on a GET

Both halves of that are deliberate.

No login, because the people who most need to stop the mail are the ones who
cannot sign in — staff reading mail on a phone, somebody whose console account
was never created. A preferences page behind authentication is a preferences
page that does not work for them, and an unsubscribe link that does not work is
what turns a notification system into a spam complaint. The authorization is the
signed token, which names the tenant, the address and the kind.

Acting on the GET is the exception to the usual rule about side effects, taken
knowingly. Mail clients do not POST; link scanners that prefetch are the reason
`List-Unsubscribe-Post` exists at all; and the worst case is that somebody stops
receiving email they can have restored by asking. A form that half of recipients
never reach is the worse outcome.

Putting an address back on the list is the asymmetric half: it needs
`config:update`, a written reason, and an audit row. Somebody said stop, and
undoing that is a decision about another person's inbox.

## The tenant is in the token, not in the URL

The unsubscribe link and the bounce webhook share a rule with intake: the tenant
comes out of the credential, never out of a parameter beside it.

For an unsubscribe link the reason is specific. The address in the token is not
a secret — it is printed in the mail, forwarded, quoted in replies. If the
tenant were a separate path segment, a recipient could edit it and opt somebody
out of a business they had never been written to. Signing the tenant *with* the
address and the kind means the only thing a token authorizes is the exact
preference it was minted for.

The same signature carries a purpose string, which is what lets portal links and
unsubscribe links share `PORTAL_SECRET`. Without domain separation, the
unsubscribe link at the bottom of every notification would verify as a portal
token — and a portal token is read access to somebody's ticket history.

## A check that cannot fail is decoration

Every check in `health.ts` touches the thing it claims to check: a real query
against Postgres, a real Redis round trip, real queue depths, the real age of a
real heartbeat row. None of them reads configuration and reports `ok`.

The distinction matters because the failure mode is silent and permanent. A
health check that returns `{database: "ok"}` because `DATABASE_URL` is set will
keep returning it through the entire outage, and the monitor built on it will
stay green while nothing works. Nobody discovers this until the day it matters,
because a check that always passes and a check that is passing look the same.

The cost is that `/healthz` does real work on every request, which is a reason
some deployments cache it. This one does not: the endpoint is cheap, the checks
are bounded by an explicit timeout, and a cached health result is a health
result about the past.

## Liveness is an age, not a status

Nothing in this system ever writes "the worker stopped". The worker writes a
heartbeat row every twenty seconds; the health check reads how old that row is
and decides.

The reason is that a process cannot be relied on to report its own death. A
graceful shutdown could write a status — and does remove its row — but a crash,
an OOM kill, a severed network and a hung event loop all produce exactly the
same thing: nothing. A status column would say `running` through all four.

Staleness is therefore the signal, and the thresholds are policy rather than
data: stale at 90 seconds, dead at 300, against a 20-second beat, so a single
missed write is not an alert and four are. `latestHeartbeat` returns the number
of seconds and no verdict, which keeps the query a query and leaves the
judgement in one place with the rest of the judgements.

## An unauthenticated endpoint may not explain itself

`checkHealth` gathers error text, queue depths, connection counts, the model in
use and the transport configured. `publicHealth` throws all of it away and
leaves names and statuses.

`/healthz` is reachable by anybody who can reach the service, which in most
deployments means anybody. "Cannot connect to postgres at
db-prod-3.internal:5432" is a free map of the internal network; the queue depths
say how busy the business is; the model name and the transport say which vendors
to phish. None of that changes what a monitor does, and a monitor is the only
thing that should be reading this.

The projection lives in `health.ts` rather than in the route, so the rule is
enforced once. A second endpoint cannot forget it, because the detailed report
is not what gets serialized — it is the input to a function whose output has no
field to leak.

## Readiness is narrower than health

`/healthz` reports everything. `/readyz` reports only the dependencies whose
failure means this instance should stop receiving traffic, which today is the
database alone.

They are read by different things, and conflating them is how a deployment takes
itself offline. A load balancer acting on `/healthz` would drain every instance
of a deployment running in shadow mode with no mail transport configured —
states that are deliberate, that the console works perfectly well in, and that
no amount of restarting will change. The outage would be entirely self-inflicted
and would look, from the dashboard, exactly like the problem it was reacting to.

The same asymmetry decides what makes the overall status `down` rather than
`degraded`. Redis being gone is serious — the agent stops — but a person can
still read a queue and answer a ticket, so it is a degradation. Calling it a
total outage would train whoever is on call to ignore the word.

## An API key is a role, not a scope

A key carries one of the same six roles the console uses, and
`contextForApiKey` builds an ordinary `TenantContext` from the same
`ROLE_PERMISSIONS` table. There is no `scopes` column, no `tickets:read` string
parsed out of a token, and no permission check anywhere in the data layer that
knows whether its caller is a person or a credential.

The alternative — a scope system beside the role system — is two descriptions of
the same policy, and the interesting question becomes which one wins. They agree
on the day they are written. They disagree the first time a permission is added
to a role and not to the scope list mirroring it, and the disagreement is
discovered by a key doing something its role could not.

What this costs is granularity: a key cannot currently be "this role, but read
only". The answer for now is that roles are cheap to add and a narrower role
benefits people too, which keeps the two surfaces converging rather than
diverging.

## Minting a key is a security change, not a settings change

`createApiKey` requires `security:update`, which an ordinary admin does not
hold. An admin can invite people, change configuration and execute actions, and
still cannot issue an API key.

That looks inconsistent until you look at what a key is. It outlives the session
of the person who made it, it is not tied to a browser or an address, it carries
a role of its own, and it is pasted into a system outside this deployment's
control. That is the shape of an integration secret rather than of a setting —
and integration secrets are exactly what `security:update` was split out of
`config:update` to guard.

The ceiling is `grantableRoles`, the same function that decides which roles a
person may grant: a key can never carry authority its creator could not hand to
a colleague. Without that, key creation would be privilege escalation with an
audit row saying it was authorized.

## Tickets have one front door, whatever knocked on it

`POST /api/v1/tickets` calls `intakeMessage` — the same function email and the
portal call — rather than inserting a row.

Everything that makes intake safe lives behind that function: deduplication by
source id, identity resolution, threading, secret scrubbing, the untrusted-input
wrapper, and the triage enqueue. A second create path gets three of the six on
the day it is written, and the one it skips is discovered when somebody sends a
password to the API and it is stored in the clear.

It also makes the API's idempotency ordinary rather than special. `external_id`
becomes the source message id, so a client that retries after a timeout gets the
ticket it already created, through the same mechanism that stops a redelivered
email opening a second one.

## The request log is the rate limiter

Requests are counted by selecting rows from `api_requests` inside the last
minute, not by incrementing a key in Redis.

The counter would be faster, and for a deployment serving thousands of requests
a second it would be the right answer. At this volume the table wins for a
different reason: the rows that enforce the limit are the rows that answer "what
has this key been doing" — a question about a credential somebody else holds,
asked during an incident, and nothing else in this schema could answer it. A
Redis counter enforces the limit and remembers nothing.

Both jobs being one table also means the limit cannot quietly stop working. If
the logging breaks, the limiter counts zero and the failure is loud; kept
separately, the limiter would go on counting a number nobody could reconcile
against the requests that actually arrived.

## The build states which migration it expects

`EXPECTED_MIGRATION` is a constant in `health.ts`, and a test fails the build
when it does not match the highest-numbered file in `db/migrations`.

It catches one specific outage: the code is deployed and the migration is not.
Every symptom of that appears somewhere else and reads as something else — a
missing column in a query nobody changed, a tool throwing on a table that does
not exist yet, an insert failing a constraint that was supposed to have been
relaxed. "Database is at 0013, this build expects 0014" is the same information
an hour earlier, in the place somebody is already looking.

Being behind is degraded rather than down on purpose. Most requests touch tables
that have existed for versions, and turning the thirty seconds between a rolling
deploy and its migration into a hard outage would be its own incident.

## A pause moves the deadline; it does not subtract from a total

When a ticket comes back from `awaiting_user`, both deadlines and both warning
instants move forward by the time it spent waiting. The alternative — leaving
the deadline where it is and keeping a running total to subtract at the moment
somebody asks — was rejected for one reason: every reader would have to remember
to subtract.

There are five of them. The console queue, the ticket page, the requester
portal, the REST API and the warning sweep all ask "is this ticket late", and
the sweep asks it in SQL. A subtraction that four of them apply and one forgets
is a bug that only appears on tickets that have been paused, which are exactly
the tickets nobody tests by hand. Moving the stored deadline means a reader that
knows nothing about pausing is still correct.

What it costs is that the original target is no longer on the row. That is what
`sla_paused_minutes` is for — the deadline answers "when", and the accumulated
total answers "how much of this was us", which is the question an SLA review
actually asks.

The pause is also credited in the units the clock runs in. A P3 that waits from
Friday afternoon to Monday morning gets back three business hours, not
sixty-four calendar ones, because the deadline it is being measured against was
set in business minutes. Handing back calendar time would let a ticket paused
over a weekend acquire a deadline later than one raised the following Monday.

## The measurement and the warning read the same instant

`slaStatus` used to decide "due soon" at `Math.max(15, 0)` minutes — a flat
fifteen, with a second argument nobody ever filled in — while the notification
query computed a share of the window in SQL. So the console called a P4
`on_track` at the same moment the sweep emailed somebody to say it was at risk,
and a P1 whose entire target is fifteen minutes was born `due_soon`.

Neither number was defensible on its own, but the real defect was that there
were two. This is the same rule as "one implementation of every number", applied
to a threshold rather than a statistic: `warningLeadMinutes` is the only
definition, `computeSla` applies it once, and the result is stored on the ticket
as `first_response_warn_at` and `resolution_warn_at`. The SQL contains no
percentage arithmetic at all any more — it compares `now()` to a column.

Storing it rather than deriving it is what makes that possible. The threshold is
a share of a window measured in *business* minutes, and Postgres cannot compute
that without a second copy of the working-hours calendar written in SQL — which
is the thing being removed. The trade is that changing
`sla_warning_at_percent` applies to tickets stamped after the change rather than
to open ones. That is the same semantic the deadline itself already has, and it
is the better half of the trade: a tenant that tightens the threshold at 4pm
should not cause a hundred warning emails about tickets that were fine at 3:59.

## A stopped clock says so

A paused ticket reports `paused` rather than a countdown. The countdown would be
accurate — the deadline has not moved yet — and it would be actively misleading,
because the number is not going down and the deadline is going to change the
moment the requester replies.

The exceptions are the two states that are already decided: a deadline that has
gone past still reports `breached`, and a target already met still reports
`met`. A pause cannot un-breach something, and hiding a breach behind "paused"
would lose the one state somebody has to act on.

What "gone past" is measured against matters. A stopped clock is read at the
instant it stopped, not at now. The stored deadline does not move until the
pause ends, so reading it against the wall clock turned a deadline that merely
passed while the requester held the ticket into a breach, and then turned it
back when they replied. That is what the audit mistook for a resume clearing a
breach. The only breach a pause cannot undo is one that had happened before the
clock stopped, and its lateness is frozen for the length of the pause. Every
state and transition, with the test that pins it, is in [sla.md](sla.md).

The sweep applies the same rule by excluding paused tickets outright. Warning
somebody about a deadline that is about to move is how a warning becomes noise.

## A priority change restamps from `created_at`, whoever makes it

A retriage always restamped the deadlines for the new priority. A person
correcting the priority in the console changed only the priority. So a P3 that
somebody re-marked as P1 kept a day-long deadline on what was now an outage, and
the same correction moved the deadline or left it depending on who made it.

Both paths now restamp from `created_at` and carry the pause credit already
given. The alternative was to count the new target from the moment of the
change. That was rejected because the priority is a statement about the ticket,
not about the moment somebody noticed it. A P1 left at P3 for three hours was
late for three hours, and counting from the correction would hide that. The
same rule works in the other direction: a downgrade gives the desk the longer
window it was always owed.

The rule stops at a clock that has already settled. Once the first response has
gone out, or while the ticket is resolved, that clock keeps its deadline and
therefore its met or breached result. The console's reclassify form is also how
the calibration table gets its labels. Without the stop, a reviewer relabelling
last month's closed tickets would rewrite last month's SLA figures, turning met
targets into breaches or erasing real ones, as a side effect of labelling. "It
was always that priority" is true, but the desk was measured at the time
against the priority it had then. A reopen unsettles the resolution clock, and
that clock is then stamped for the priority the ticket has by then.

The rule sits in SQL (`SETTLED_CLOCKS`), shared by the retriage and console
writes, so it is judged against the row being updated and the two paths cannot
drift apart again. A downgrade of an open ticket that is already late can still
un-report its breach. That is left to the breach-as-fact question (D1 in
[sla.md](sla.md)) rather than special-cased here. Every restamp writes an
`sla_restamp` event in the same transaction, like a pause, so the timeline
explains every deadline that moves.

## A pause credits a clock only while it is running

A pause exists to give the desk back time it could not use. That applies only
to a clock that was running. A first response sent before the pause began was
not stopped by it, so the resume no longer moves that clock's deadline. Moving
it had let an hour of waiting turn a late reply into an on-time one.

A first response recorded during the pause gets the part of the pause before
it, and that credit is applied when the response is recorded. The simpler fix
was considered and rejected: keep crediting at the resume, but stop the credit
at `first_response_at`. It computes the same final deadline. But until the
requester replied, the response would be judged against a deadline that had
not yet received its credit. A reply sent in time could read `breached` for
days and then change to `met`. That is a recorded result changing after the
fact, which is what I4 forbids. It would also break D1, which records the first
breach anybody sees and never clears it. Settling at the moment of the
response means the result reads the same from then on.

A clock that had breached before it stopped is credited nothing. The credit
preserves lateness, so this makes no difference to the result except in one
case. A business-hours deadline at closing time, paused after hours, is late by
the calendar and by zero working minutes. Crediting it would land the deadline
exactly on Monday's reply and record `met`, after the console had shown
`breached` all weekend. The breach check is `slaStatus` itself, so the question
is answered by the same code the console uses.

The general principle is at the top of [sla.md](sla.md). A running clock's
deadline can move with a pause, a retriage or a priority change. A recorded
outcome cannot, and a reopen starts a new resolution period rather than
rewriting the old one.

## The conversation is a log, not a comments table

A comments table stores what people typed. The questions this product has to
answer about a conversation are harder than that. Did the requester see it? Did
a person write it or a model, and with which prompt? Which draft became which
reply? What order did things happen in when two writes share a millisecond? Was
the retried webhook the same message?

So the conversation (`docs/conversation.md`) is an append-only log with a
gap-free sequence, a visibility, an author derived from the context, provenance
for the agent's rows, and an idempotency key per tenant. Each append also
writes an audit event. Four alternatives were rejected:

- **Ordering by timestamp.** Two clocks, or two writes in the same millisecond,
  reorder it, and an email's `Date` header is whatever the sender's machine
  said.
- **Letting callers name the author.** An author a caller can name is an author
  a caller can forge. `outbound_messages.created_by` had already settled this
  for outbound mail.
- **Editable drafts.** A draft that changes in place loses the thing worth
  knowing: what the agent proposed, against what a person sent. Sending a draft
  writes a new message derived from it.
- **The body in the audit event as well.** The words would then be stored twice,
  in two places a redaction would have to find. The event points at the message
  instead.

The database enforces most of it (append-only triggers, author and visibility
shape checks, and composite foreign keys that keep every reference in one
tenant), so a writer that bypassed the repository would still be refused.

## Old threads are copied into the conversation, by whichever write gets there first

Tickets from before the conversation keep their words in `ticket_events`. They
are copied in (D4 in `docs/conversation.md`) rather than read from two places,
so no reader ever has to know how old a ticket is. A copy claims only what its
record holds. The agent's old replies become `system` messages, because their
events never recorded a model and inventing one would be false provenance.

The backfill script is not the only copier. It refuses a ticket whose
conversation already holds something newer than an uncopied record, because
appending the copy would put it after words that came after it. That refusal
is right, and it made the deploy order matter: one requester reply to an old
ticket before the script ran would have stranded that ticket's history for
good, in an append-only table with no way back. So the first write to any
conversation copies its ticket's history before itself, in the same
transaction and under the same lock. The script remains, for the tickets
nobody writes to again. Correctness no longer depends on who runs what first.

## Time spent resolved belongs to the requester

When a ticket is resolved the ball is with the requester, as it is in
`awaiting_user`, so time spent resolved or closed does not count against the
resolution clock. A reopen gives it back, and the new clock starts with the
margin the old one had when it was resolved (D3 in [sla.md](sla.md)).

Two alternatives were rejected. Keeping the old rule meant a requester who
reopened days after an on-time fix landed the desk a breach, and since D1 a
permanent one, for time nobody at the desk could use. Starting a full new
window at every reopen is simpler to explain, but it hands the desk a fresh
budget each time a fix bounces back, so a ticket fixed badly three times never
reads late.

The credit has its own column rather than reusing the pause. `sla_paused_at`
means "waiting in `awaiting_user`" to the console, the warning sweep, the breach
sweep and the first-response clock, and `sla_paused_minutes` is added to both
clocks by every restamp. A resolution stops only the resolution clock, so its
credit goes to that window only.

## Every clock writer computes from the row it locked

A retriage used to receive its stamp from the pipeline, computed from the
ticket as it was read before the model call. A resume that committed during the
call was then overwritten. One fix was to keep the stamp outside and add a
guard: write it only if `sla_paused_minutes` still had the value it was
computed from. That was rejected. It is the same optimistic check `setStatus`
once had, and that check failed because it guarded one column while another
writer changed a different one. It would also have left the retriage with
nothing sensible to write when the guard failed.

So `applyTriage` computes the stamp itself, from the row it has locked, as the
other four writers do. The triage result no longer carries deadlines, so no
caller can supply one from an earlier read. The one input that is not row
state is the SLA policy. The pipeline passes the settings the decision was
made under, rather than `applyTriage` reading them again, so the stamped
targets and `config_version` always come from the same configuration.

## A capability link reaches its owner by mail, never by redirect

The portal form used to finish by redirecting to the portal link for whatever
address had been typed into it. The form is unauthenticated, so that was the
whole ticket history of any requester, replies included, for the price of
knowing their email. The link is still the right shape for "tell me about my
own ticket"; what changed is how it is delivered. It now arrives only in mail
sent to that address, which is the one channel that proves the reader owns it.

The same reasoning removed `x-delivered-to` as a credential on the intake
webhook. A tenant's support address is printed in every signature, so on its
own it authenticated nobody. It still chooses the tenant, but only alongside
the provider's shared secret. And the login page's `next` parameter is now
limited to a path on this site, because a redirect target taken verbatim from
a URL is a phishing trampoline with our domain on the front.

## `resolved_at` means resolved, and still resolved

It used to be set on the first resolution and never cleared, so a reopened
ticket kept it. Every reader then went wrong differently. The follow-up sweep
judged a re-resolved ticket against the first resolution, found the reply that
had caused the reopen, and reopened it again on every run. The SLA badge said
`met` on a ticket being worked, and the warning sweep, which skips anything
with a `resolved_at`, never warned about it.

The column is now set on entering `resolved` or `closed`, kept when a resolved
ticket is closed, and cleared on leaving both. `closed_at` follows the same
rule. What is lost is "when was this first resolved", which nothing read, and
which the event log still answers.

## A consequence of a reply runs as the system

A requester's reply reopens a resolved ticket, and restarts the clock on one
that was waiting on them. Those transitions used to run with the context of
whatever delivered the reply, and the channels are the least privileged callers
in the product. The portal holds `ticket:read` and `ticket:create`, and an API
key has whatever role it was issued with. Both threw on the reopen, after the
reply had already been written. The follow-up sweep had the same problem from
the other side: it runs as the agent, which does not hold `ticket:reopen`.

The transition is a rule, not anybody's decision, so it now runs with the
system's authority inside the same tenant. This does not widen what a caller
can do. The caller still cannot choose the status, only deliver a reply, and
`ticket:reopen` remains a manager's permission everywhere a person chooses it.

## Bulk actions are single actions, repeated

`bulkUpdate` used to be one `update ... set status`. It checked
`ticket:update` for every status, so an agent could close and reopen in bulk
what the ticket page would refuse. It also skipped the SLA pause and the
outcome columns, so a bulk resolve left `resolved_at` empty and those tickets
were never followed up. It now calls `setStatus` per ticket, and checks the
permission for the target status once, before touching any of them. A
cross-tenant assignee is refused up front, not written onto every row.

## Uniqueness that arrives from outside is per tenant

Message-IDs and API `external_id`s are chosen by somebody else, so two tenants
can legitimately present the same one. Both the intake dedupe index and the
threading table were unique on the id alone. The second tenant's intake then
threw, and the difference between that 500 and a 201 told one tenant which ids
another had seen. Migration 0016 adds `business_id` to both keys.

## Role changes need reach over the member, not only over the role

`roleWithinReach` stopped an admin *granting* `security_admin`, but nothing
stopped an admin demoting or removing one, and re-inviting an existing member
overwrote their role without any of `setRole`'s checks. Changing someone's
access now requires that the actor could have granted the role they currently
hold, and an invite for an existing member is routed through `setRole`.

## A breach is recorded once and never cleared

A breach was a reading, and a reading follows the deadline, which a downgrade
could move. Now each target has `*_breached_at`, set by the first write or sweep
that sees the breach, beside an `sla_breach` event in the same transaction. The
history lives on the existing event log. The columns are the projection that
reports and `slaStatus` read. A separate breach table was considered and
rejected, because it would be a second history with its own chances to
disagree with the log.

`breached_at` is the deadline the clock missed, not the moment somebody noticed.
Noticing depends on when the next write or sweep came, so it would make two
identical tickets report different instants. The deadline is the same whoever
records it, which also makes a retried recording write the same value. When it
was noticed is the event's timestamp.

The resolution target needed two things on the row. The history, "was it ever
missed", must survive a reopen, because a recorded result is never rewritten. The new clock a reopen starts must still be able to
run, so it cannot be forced to `breached` by its predecessor. So
`resolution_breached_at` is never cleared, and `resolution_clock_breached`
describes only the clock running now. A later clock's breach gets its own event
and leaves the first breach in the column. Clearing a single column on reopen,
the way `resolved_at` is cleared, was simpler, but it would erase the one fact
reports need from the row.

A breached clock keeps the deadline it missed through a restamp, but a pause
still moves it. A new priority's window would change how late the clock reads:
later after an upgrade, and back to a countdown after a downgrade. A pause
credit moves the deadline by exactly the time the clock was stopped, so it keeps
the lateness exactly (T8). The recorded breach keeps the reading at `breached`
in the one case where the credit lands the deadline on the resume instant.

Every clock writer records what its locked row shows before it changes
anything. Recording only in a sweep would leave a window in which a downgrade
could erase a breach nobody had recorded yet, and that window is the whole
defect. The sweep catches the tickets nobody touches, and it is also the
backfill. The migration writes no rows, because a SQL copy of `slaStatus`
would be the second implementation that 0015 was written to remove.

The event's actor is always the system. The person whose priority change was
the first write to see a breach did not cause it, and an audit that named them
would be wrong.
