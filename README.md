# IT helpdesk agent

An AI agent that takes support tickets, resolves what it can, and escalates the
rest — built to the phased design in `docs/design.md`, with the shared layer
extracted from the start so the business ops agent can be dropped in beside it.

**Where it is now:** phases 1–3 are working, phases 4–5 are built and switched
off, phase 6 is partly there. `AGENT_MODE=shadow` is the default, and in shadow
mode the agent contacts nobody. See [Phase status](#phase-status).

Around that sits the layer that makes it safe to point at a real inbox:
untrusted-input handling, redaction, SLA clocks, email threading, duplicate
merge and rate limits. See [The safety layer](#the-safety-layer).

---

## Quick start

```bash
cp .env.example .env      # works as-is; add ANTHROPIC_API_KEY to enable triage
npm install
npm run setup             # docker compose up, migrate, seed, ingest runbooks

npm run dev               # console on http://localhost:3000
npm run dev:worker        # in a second terminal: queue consumers + email intake
```

`curl localhost:3000/healthz` answers whether that worked — seven checks,
each of which actually calls the thing it reports on. Expect `worker: down`
until the second command is running, and `outbound_mail` and `model` degraded
until a transport and a key are configured; both are deliberate states. The
console's **System** page is the same report with the detail left in.

The console asks you to sign in. `npm run db:seed` prints five accounts, one
per role, all with the password `northgate-dev-password`:

| Email | Role | Can |
|---|---|---|
| `admin@northgate.example` | admin | everything below, plus configuration |
| `security@northgate.example` | security_admin | autonomy, thresholds, integration secrets |
| `manager@northgate.example` | manager | assign, escalate, override, approve actions |
| `agent@northgate.example` | agent | work and close tickets |
| `viewer@northgate.example` | viewer | read tickets, the knowledge base, analytics |

Sign in as the viewer at least once. It is the fastest way to see that the
permissions are real: the approval buttons are gone, the draft is readable but
not sendable, and `/settings` and `/audit` are not in the navigation — and
typing those URLs directly gives a refusal rather than the page.

Then put some tickets through it:

```bash
npm run intake:drop       # copies the sample emails into the intake folder
```

The worker polls every five seconds. Tickets appear in the queue, and each one
gets a triage, a retrieval, a decision and a draft you can read on its page.

Replies go out through a real transport. The development default writes them to
`db/seed/outbox` as `.eml` files — the whole delivery path runs (queue, claim,
retry, status, history) and nobody outside receives a test email. Open one; it
is a real message, with the threading headers that make the answer land in the
same conversation. **Outbound mail** in the console shows every message, what
happened to it, and the addresses that have stopped accepting our mail. One of
the sample emails is a bounce, so that last column has something in it.

Requesters have their own door at `/portal/new` — the same intake path as
email, so it dedupes, resolves identity and scrubs secrets identically — and
the form hands back a signed link to a status page they can reload.

Without `ANTHROPIC_API_KEY` everything runs except triage and drafting: tickets
arrive, deduplicate, enrich and land in the queue marked for a human. That is
the designed degraded state, not a crash.

### Seeing the decision branch without a worker

```bash
npm run demo              # parses every sample email and drives the pipeline inline
```

Prints, per ticket, what the agent classified it as, which rule fired, what it
would have done with full autonomy, and what it actually did.

---

## What it does with a ticket

```
intake ─► enrich ─► triage ─► retrieve ─► decide ─► execute ─► follow up
```

1. **Intake** — email (webhook or folder poller) and the requester portal's
   web form, both normalized to one `InboundMessage` through one door.
   Deduplicated per tenant on `(source, source_message_id)`, so webhook retries
   are free and one email copied to two tenants opens a ticket in each;
   threaded onto an existing ticket when the headers say it is a reply; and
   credentials are scrubbed out of the body before the row is inserted.
2. **Enrich** — requester, department, role, VIP flag, assigned device, their
   last fortnight of tickets, and any active incident.
3. **Triage** — one structured call returning category, priority, confidence,
   security and destructive flags, missing information, and a duplicate hint.
4. **Retrieve** — pgvector search over runbooks, vendor docs and resolved-ticket
   writebacks. Superseded chunks are excluded at the query.
5. **Decide** — the branch below. The SLA clocks are stamped here, because
   they cannot be set before the priority is known.
6. **Execute** — through a tool layer with risk tiers and an approval gate.
7. **Follow up** — 24h check, then close, then write the resolution back into
   the knowledge base.

### The decision branch

Rules fire in order, first match wins. Everything that can stop the agent runs
before anything that lets it act. It is a pure function in
[decide.ts](packages/agent-helpdesk/src/decide.ts) with 30 tests against it.

| # | Rule | Outcome |
|---|---|---|
| 1 | `destructive_request` | escalate — no confidence score and no tenant setting overrides this |
| 2 | `security_sensitive` | escalate |
| 3 | `injection_suspected` | escalate — the text tried to steer the agent, so the classification drawn from it is suspect too |
| 4 | `vip_requester` | escalate — tenant routing, not a judgement about the ticket |
| 5 | `department_policy` | escalate — Legal, HR, Finance, whoever the tenant lists |
| 6 | `priority_p1` | escalate |
| 7 | `known_incident` | link to the parent outage and acknowledge |
| 8 | `missing_info` | ask one targeted question, then wait |
| 9 | `clarify_exhausted` | escalate after the tenant's clarify budget |
| 10 | `low_confidence` | escalate — below the per-category threshold |
| 11 | `no_kb_support` | escalate — confident with no runbook is how you get a fluent wrong answer |
| 12 | `whitelisted_action` | run the tool, then reply |
| 13 | `confident_with_runbook` | reply and resolve |

Two independent gates sit after the branch, and both must open before the agent
contacts anyone: the deployment's `AGENT_MODE`, and the per-category autonomy
level in `businesses.settings`. Neither can widen the other.

### Risk tiers

| Tier | Unattended? | Examples |
|---|---|---|
| `read` | always | directory lookup, MDM status, ticket history search |
| `internal` | always | escalate, set status — writes to our own record, contacts nobody |
| `safe_write` | only if whitelisted per tenant | send reply, password reset, unlock, grant licence |
| `sensitive` | never | add to group |
| `destructive` | never, approval required | remove from group, disable account, wipe device |

The whitelist is explicit and empty by default. Blacklisting is the wrong
shape: the dangerous action is always the one nobody thought to list.

---

## The safety layer

### Untrusted input

A ticket body is written by whoever emailed the helpdesk, which in most
companies is the whole internet. It is data. It is never instructions. Four
layers, in descending order of how much they actually protect you:

1. **The agent cannot choose a tool from free text.** `actions.ts` maps a
   classified category to at most one candidate and the whitelist decides
   whether it runs, so even a fully successful injection cannot reach a tool
   that is not in the table. This is the layer that matters.
2. **Triage output is a constrained schema.** The worst an injection gets is a
   wrong classification — and a wrong classification with honest confidence
   routes to a human anyway.
3. **Untrusted spans are fenced with a per-call nonce**, so content cannot
   close its own block and start issuing instructions outside it.
4. **The system prompt says all of the above out loud.**

Layer 3 is the one people reach for first and the weakest of the four; it is
there because it is nearly free, not because it is sufficient. When the scanner
trips, rule 3 escalates and the console flags the ticket.

### Redaction: two jobs, two answers

**Secrets are scrubbed at rest** — at intake, before the row is inserted. A
plaintext password in a ticket body is a liability the moment it is written,
nobody needs to read it, and the requester should be changing it anyway.

**PII is redacted in transit** — before a body reaches a model, and before it
is embedded into the knowledge base where it would be retrieved into other
people's prompts forever. It stays in the database, because names, emails and
phone numbers are the helpdesk's actual job.

Deliberately not redacted: IP and MAC addresses, hostnames, asset tags and
error codes. They look like PII to a naive regex and they are the entire
substance of an IT ticket. Redacting them produces a model call that cannot
answer the question.

### Clocks, threads and loops

- **Two SLA clocks.** A P1 at 2am does not get to wait until nine, so its clock
  is calendar time. A P4 raised at 4:55pm on Friday should not breach over the
  weekend, so its clock only runs during the tenant's business hours. Both are
  stamped at triage and shown in the queue and the portal.
- **Threading.** Replies join their ticket by `Message-ID`, `In-Reply-To` and
  `References`, with a subject tag as the fallback for clients that strip
  headers. Without it, "thanks, that worked" arrives as a new P3, gets triaged,
  and gets a runbook reply.
- **Merge.** Duplicates are *proposed* — same requester, same category, opened
  close together — and a human picks the survivor. The merged ticket is closed
  with a pointer rather than deleted, and its timeline moves across, because
  "where did my ticket go" has to be answerable.
- **Rate limits.** Per requester and per tenant, per hour. This is about loops,
  not cost: a mail server that bounces the agent's reply back to the agent
  otherwise runs until somebody notices. Hitting the limit parks the ticket for
  a human — the same degraded state as every other failure.

---

## Outbound mail

A reply is a row before it is an email. `ticket.send_reply` renders the message
— threaded, subject-tagged, addressed from the address the tenant *receives* on
so an answer to the answer comes back into the same tenant — writes it to
`outbound_messages`, and returns `queued`. Nothing in a request path talks to a
mail server: on a timeout the caller could not tell whether the person had been
contacted, and retrying the job would either duplicate the mail or lose it.

A worker owns the rest, and the row owns the state:

- **Delivery status.** Seven of them, and every transition is recorded with
  whatever the provider said. `sent` means the provider accepted it — not that a
  person received it, which is a distinction the console works to keep.
- **Retry and a dead-letter queue.** Jittered exponential backoff, an attempt
  budget per message, then the dead-letter list at `/mail` with the error that
  stopped it and a button that tries again. The jitter matters more than the
  curve: without it a provider outage releases every queued message at the same
  instant and knocks the provider over again the moment it recovers.
- **Idempotency.** `(business_id, idempotency_key)` is unique, and the default
  key is the ticket plus a hash of the body — so a double-clicked Send button, a
  retried job and a redelivered webhook are one email.
- **Bounces and complaints.** An SMTP deployment learns about failures as mail:
  a delivery status notification arriving at the intake address, which used to
  be dropped as an auto-reply and is now parsed and matched to the message by
  Message-ID. An API deployment gets a webhook at `/api/outbound/events`,
  authenticated with the tenant's intake token. A hard bounce or a complaint
  suppresses the address for that tenant and lifting it is audited; a soft
  bounce is recorded and nothing else, because a delay notice is the far side
  saying it is still trying.
- **The ticket finds out.** A reply that never arrives no longer leaves a ticket
  looking answered: the dead letter writes an `error` event and the ticket goes
  back to `triaged`, which routes to a person and never back to the agent.

Three transports, chosen with `OUTBOUND_EMAIL_PROVIDER`:

| Value | What it does |
|---|---|
| `spool` | Renders the real message to `OUTBOUND_SPOOL_DIR`. The development default: the entire path runs and no stranger receives a test email |
| `smtp` | A real server through a nodemailer connection pool. `SMTP_URL`, or the host/port/user/password keys. 587 requires STARTTLS rather than falling back to plaintext |
| `postmark` | The transactional API, one `fetch`, `POSTMARK_SERVER_TOKEN`. Point its bounce and delivery webhooks at `/api/outbound/events` with the tenant's `x-intake-token` |
| `none` | Sends nothing. Replies are recorded and parked as `cancelled`, so nothing accumulates retries against a transport that is never coming |

The kill switch reaches the queue. A reply the agent queued in `auto` is
cancelled if the tenant's mode narrowed before it went out — otherwise "flipping
the switch stops outbound contact" would be false for anything already in
flight. A human's reply is not subject to that: shadow mode is a statement about
the agent.

### Notifications

Five of them, all on by default. That is the opposite of how autonomy defaults,
and deliberately: an unsent notification is a person not finding out.

| Notification | Goes to | Notes |
|---|---|---|
| Assignment | the person who got the ticket | one email each up to a handful, then a single covering note — a bulk reassignment is one decision |
| SLA warning | the assignee, else the queue | at a share of each ticket's *own* window, default 20%: three minutes on a P1 target, most of a day on a P4 |
| Escalation | the queue the agent handed it to | with the agent's suggested fix, labelled unverified |
| Approval | whoever holds `action:approve` | with the deadline in it. Without this, an approval expiring overnight reads exactly like a refusal |
| Resolution | the requester | only when a *person* resolves it, threaded onto their own conversation, and skipped if a reply just went out |

Consent lives in two places, which is the part worth knowing:

- **Tenant policy** is in `businesses.settings` under `notifications`, on the
  Settings page. Versioned and audited like anything else — and the master
  switch and the approval notice are classified *critical*, because silencing
  either reduces human oversight of the agent. Turning them off needs
  `security:update`, a reason and a confirmation; turning them on needs none of
  that.
- **A person's own opt-out** is a row in `notification_optouts`, not a setting.
  Every staff notification carries two signed links — stop this kind, stop
  everything — that work with no login, because the people who most need them
  are the ones without a console account. A configuration rollback cannot
  resubscribe somebody: their choice was never part of the snapshot. Putting an
  address back needs `config:update` and a written reason.

Deduplication is per kind: once an hour per person per ticket for most, once per
request for an approval, and once per clock for an SLA warning — so a ticket
sitting at 19% of its window for three hours produces one email, not
thirty-six.

A notification is queued by the system rather than by the person who caused it.
A manager can assign a ticket and does not hold `action:execute`; the email is a
consequence of an authorized action, not a second privileged action by that
person. What keeps that safe is that `notify()` can only render one of five
templates to a recipient resolved from the tenant's own directory — arbitrary
text to an arbitrary address is `ticket.send_reply`, and that is gated.

---

## Is it alive?

Three endpoints and a console page, read by three different audiences.

| | Who reads it | What it says |
|---|---|---|
| `GET /healthz` | Monitors, uptime checks | Seven checks by name and status. 200 while requests can be served, 503 when they cannot |
| `GET /readyz` | Load balancers, orchestrators | Whether this instance should receive traffic |
| **System** page | Whoever is on call | The same checks with latencies, error text and queue depths, every process's heartbeat, and recent API traffic. Needs `config:read` |

Every check touches the thing it claims to check — a real query, a real Redis
round trip, real queue depths, the real age of a heartbeat row. A check that
only reads configuration cannot fail, and one that cannot fail is decoration.

| Check | Down means | Degraded means |
|---|---|---|
| `database` | Nothing works. The only check that makes the whole report `down` | A simple query took over 500ms |
| `migrations` | `schema_migrations` unreadable | The schema is behind what this build expects |
| `redis` | Intake still writes tickets, and records that it could not queue them | — |
| `queues` | Redis unreachable | Over 100 waiting, or anything in the dead-letter list |
| `worker` | No heartbeat for five minutes: triage, delivery and the sweeps are not running | No heartbeat for ninety seconds |
| `outbound_mail` | — | `spool` or `none`: nothing reaches a requester |
| `model` | — | No credentials: tickets arrive, deduplicate and park for a human |

The last two are configuration rather than faults, and they read as degraded on
purpose: "nothing has been sent all week" has an explanation nobody thinks of
until a page states it.

`/healthz` serves names and statuses only — no error text, no queue depths, no
versions. It is reachable by anybody who can reach the service, and "cannot
connect to postgres at db-prod-3.internal:5432" is a free map of a deployment.
The detail is behind the console session on the System page.

`/readyz` is narrower than `/healthz` on purpose. It fails only on the
dependencies that should drain an instance, so a deployment sitting in shadow
mode with no mail transport does not take itself out of the load balancer for a
state that is deliberate.

**Worker liveness is an age, not a status.** The worker writes a heartbeat every
20 seconds and deletes its row on a clean shutdown. Nothing ever writes
"stopped": a crash, an OOM kill and a hung event loop all produce the same
thing, which is silence, and only the timestamp separates that from an idle
afternoon. Run two workers by giving each a distinct `WORKER_ID`.

---

## The REST API

`/api/v1`, authenticated with a per-tenant API key.

```bash
curl -H "Authorization: Bearer hd_..." \
  "http://localhost:3000/api/v1/tickets?status=new,triaged&limit=25"
```

| Route | Needs | Notes |
|---|---|---|
| `GET /api/v1/tickets` | `ticket:read` | Filter by `status`, `priority`, `category`, `search`; page with `limit` (max 100) and `offset`. `meta.next_offset` is null on the last page |
| `GET /api/v1/tickets/:id` | `ticket:read` | Add `?include=events,delivery` for the event timeline and what was actually sent to the requester |
| `POST /api/v1/tickets` | `ticket:create` | Send `external_id` to make retries idempotent — the same id returns the same ticket with `meta.duplicate: true` |

Errors are one shape: `{"error": {"code", "message"}}`, with `422` carrying the
failing fields. A ticket in another tenant is a `404` rather than a `403`,
because across tenants "exists but forbidden" and "does not exist" have to be
indistinguishable or the id becomes an enumeration oracle.

**Keys are made in Settings → API keys** and need `security:update` — the
permission that guards integration secrets, not the one that guards settings. An
ordinary admin can invite people and change configuration and still cannot mint
a key, because a key outlives the session of whoever made it and is pasted into
a system outside this deployment.

Three properties are worth knowing before you hand one out:

- **A key carries a role**, resolved through the same grant table the console
  uses. A `viewer` key can list tickets and cannot open one. There is no second
  scope system to disagree with the first, and no key can outrank the person who
  created it.
- **The tenant comes from the key.** There is no `business_id` parameter
  anywhere in the API — nothing in a URL, a query string or a body can change
  which tenant a request reads.
- **Only the hash is stored.** The token is shown once at creation and cannot be
  recovered; a list shows the first few characters so two keys can be told
  apart. Revoking sets a timestamp rather than deleting the row, so "when did
  this stop working, and who stopped it" still has an answer.

Requests are logged per key — method, path, status, latency — which is both what
the rate limiter counts (`api_rate_limit_per_minute`, 120 by default, per key)
and the answer to "what has this integration been doing". Refusals are logged
too: a log holding only successes cannot show somebody probing. The last 25 are
on the System page, for anyone with `security:read`.

Creating a ticket goes through the same `intakeMessage` that email and the
portal use, so deduplication, identity resolution, threading and secret
scrubbing are identical on every channel.

---

## Phase status

| Phase | Plan | Status |
|---|---|---|
| 1 — Foundation | Ticket model, one intake channel, dashboard | **Done.** Email intake by webhook and folder poller, threaded onto existing tickets; queue, list, detail, event timeline, staff assignment, duplicate merge. |
| 2 — Triage | Classification shown in the dashboard, humans still decide | **Done.** Structured triage, confidence shown against its threshold, agent-vs-human agreement recorded in `triage_shadow`. |
| 3 — KB + RAG | Ingest, chunk, embed, suggested reply a human sends | **Done.** pgvector, supersession, "Send and resolve" from the ticket page. |
| 4 — Auto-resolve, narrow | Unattended replies for two safe categories | **Built, off.** Flip `AGENT_MODE=auto` and set a category's autonomy to `reply`. Do it on measured accuracy, not on vibes. |
| 5 — Actions | Identity provider, ticketing, approval UI | **Partial.** Registry, risk tiers, approval queue and audit log are real; provider write calls are honest stubs that return `{simulated: true}`. |
| 6 — Multichannel + learning | Slack/Teams, writeback, analytics | **Partial.** Writeback, analytics and the requester portal — web form in, status page out — are working; Slack/Teams adapters are not written. |

### Turning autonomy on

Do not skip to this. The order in the plan exists because phases 2 and 3
generate the data that tells you which categories are safe.

1. Run shadow mode for two weeks. Correct or confirm the classification on every
   ticket in the console — that writes ground truth to `triage_shadow`.
2. Run `npm run eval score`, or open **Analytics → Threshold recommendations**.
   Both score the same rows with the same code. For each category you get the
   lowest threshold whose 95% lower bound clears 95% accuracy, the coverage it
   buys, and whether the threshold you already have is justified by the data.
   It differs per category: access requests calibrate well, software is usually
   a mess.
3. If the category reads `insufficient data`, it has not earned a threshold
   yet — leave it in shadow. If it reads `unreachable`, no threshold fixes it;
   that is a classifier problem, not a dial problem.
4. Set that category's `confidence_threshold` in `businesses.settings` to the
   recommended value, and its `autonomy` to `reply`.
5. Set `AGENT_MODE=auto`.
6. Watch **false resolve rate** — tickets the agent closed that the user
   reopened. It is the metric that erodes trust fastest. If it climbs alongside
   deflection, the agent is closing tickets it never fixed.

### Building the golden set

Production feedback and a golden set are not the same thing. A console
correction is somebody disagreeing with the agent while working their queue; it
is evidence, and it is wrong often enough that a set built by trusting every
correction measures agreement with a busy colleague. So an export lands as
*candidates*, and only reviewed samples are scored:

```bash
npm run eval export                       # reconciled records -> candidates
npm run eval review -- --list             # what is waiting
npm run eval review -- <ticket-id> --accept --labeler you@example.com
npm run eval review -- <ticket-id> --reject --note "label is wrong"
```

Aim for 100-300 reviewed tickets spread across the categories that matter. The
split is derived from a hash of the ticket id, so adding samples never
reshuffles what was already held out, and the dataset id is computed from the
reviewed subset only — adding candidates never invalidates a pinned baseline.

### Regression testing a change

Before shipping a prompt or model change, run it against the frozen set rather
than against next week's traffic:

```bash
npm run eval replay -- --split holdout --save-baseline main   # pin today
npm run eval regress -- --split holdout                       # after the change
```

`regress` replays the holdout split and compares against the `main` baseline.
The comparison refuses to run across two different datasets, tolerates noise
per metric, has zero tolerance on the safety slice, and reports a *configuration
fingerprint* — model, prompt, taxonomy, routing rules and threshold policy — so
a change to any of them is named rather than silently folded into the delta.

`npm test` runs the free half of this automatically: it scores the predictions
already frozen in the golden file against the pinned baseline, which catches a
renamed category, a moved routing rule, a widened threshold or an edited label
without spending a token. It skips when no dataset or baseline is pinned. The
half that needs the model is `npm run eval regress`, which belongs in CI.

Add `--record` to any scoring command to write the run and its per-ticket rows
to `eval_runs` / `eval_results`, which is what lets you ask "which categories
can safely operate at which threshold" over more data than one run holds.

---

## Layout

```
apps/
  web/                  Next.js console, requester portal, intake webhook, actions
    app/api/v1/         the REST API — keyed, rate-limited, tenant-scoped
    app/healthz/        health and readiness, unauthenticated
  worker/               BullMQ consumers, email normalizer, folder intake
packages/
  core/                 tenancy, authorization, entities, event log, queue,
                        metrics, SLA clocks, redaction, threading and merge,
                        health checks and process heartbeats
    auth/               roles, permissions, the tenant context, sessions
    repos/              every query; each one takes a TenantContext
    mail/               rendering, transports, the delivery loop, bounce reading
    notify/             notification templates, consent, the SLA warning and
                        breach sweeps
  llm/                  gateway, prompt registry, pricing
  rag/                  chunk, embed, retrieve, ingest
  tools/                tool registry, risk tiers, integrations
  agent-helpdesk/       triage, decide, draft, pipeline, writeback, follow-up
  agent-ops/            placeholder for the business ops agent
  eval/                 metrics, calibration, thresholds, golden datasets,
                        baselines and replay — the only place that does
                        statistics, so the console and the gates agree
db/
  migrations/           numbered SQL, one transaction per file
  seed/                 directory + devices, runbooks, sample .eml files
                        (including a bounce), and the dev outbound spool
eval/
  datasets/             frozen golden sets, JSONL, one sample per line
  baselines/            pinned metric snapshots for regression comparison
scripts/                migrate, seed, ingest, drop-eml, demo, eval
```

The import rule that keeps this clean: `core`, `llm`, `rag` and `tools` must
never import from an `agent-*` package. If you want them to, the thing you need
belongs in core.

### Configuration change control

Autonomy lives in the database so it can change without a deploy. That is only
safe if the change leaves a trail, so every accepted settings change produces
two things in one transaction: a numbered, immutable snapshot in
`config_versions`, and one `audit_events` row per changed field carrying the
actor, both values, a reason, the request id and an impact sentence.

Fields are classified `critical` or `normal` in
[config-policy.ts](packages/core/src/config-policy.ts). Critical means it
governs what the agent may do without a person. Those need `security:update` and
a written reason.

Direction matters more than risk. A change that *widens* autonomy — a lower
confidence threshold, a newly whitelisted tool, removing the kill switch — also
needs an explicit acknowledgement of its impact, and a second administrator when
the tenant turns that on. A change that *narrows* autonomy needs none of it: the
brake has to work immediately, and a brake that waits for a colleague is not a
brake.

Tickets are stamped with the configuration version that decided them, so
replaying a ticket from six weeks ago uses the thresholds that actually applied.
The ticket page shows all three legs — prompt version, model, config version.

Rollback creates a new version rather than removing one. v17 set the threshold
to 0.82; rolling back produces v18 holding 0.90, and v17 stays in the history.
`audit_events` and `config_versions` refuse updates and deletes at the database
level, including from this application's own connection.

### Authorization

Every query lives in `packages/core/src/repos` and takes a `TenantContext` as
its first argument. The context is a branded type, so it cannot be constructed
from a query string — it comes from a resolved session, or from one of three
named constructors (`agentContext`, `systemContext`, `portalContext`) that are
all one grep away. The tenant in it goes into the SQL predicate, which means a
cross-tenant id matches no row rather than relying on a guard clause somebody
remembered to write.

Feature code asks `can(ctx, "config:update")`. It never tests a role string:
a role check scattered across call sites is a policy nobody can read in one
place, and the first time a role is added you find the six sites that forgot
about it. The grant table is `packages/core/src/auth/permissions.ts`.

Three things enforce this beyond review:

- `packages/core/test/isolation.test.ts` builds two tenants and attacks each
  from the other, across every resource — tickets, events, requesters, devices,
  staff, knowledge base, users, memberships, approvals, settings, integration
  credentials, analytics, the audit log, sessions, the outbound mail queue, API
  keys and the API request log.
- `packages/core/test/tenant-scoping.test.ts` reads the source and fails the
  build if a repository function drops its context, a server action skips
  `requireConsole()`, a page writes its own SQL, or `human:console` comes back.
  It needs no database, so it runs on every push.
- CI runs both, and sets `REQUIRE_DB=1` so a Postgres that failed to start is a
  red build rather than a green one that tested nothing.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Containers, migrations, seed, runbook ingest |
| `npm run dev` | Dashboard on :3000 |
| `npm run dev:worker` | Queue consumers and intake poller |
| `npm run demo` | Whole pipeline inline over the sample emails |
| `npm run intake:drop [filter]` | Copy sample emails into the intake folder |
| `npm run kb:ingest [dir]` | Ingest a folder of markdown runbooks |
| `npm run db:reset` | Drop, recreate, migrate, seed |
| `npm run eval score` | Score the reconciled shadow records: accuracy, calibration, routing, thresholds, gates |
| `npm run eval export` | Freeze those records into `eval/datasets/triage-golden.jsonl` as review candidates |
| `npm run eval review` | List, accept or reject candidates — the only way a sample becomes golden |
| `npm run eval replay` | Re-run triage over the reviewed set with the current prompt and model (spends tokens) |
| `npm run eval regress` | Replay and compare against the pinned baseline. The one to wire into CI |
| `npm run bench:intake [n] [concurrency]` | Time intake → enqueued under load and report p50/p95/p99 |
| `npm test` | 611 tests, plus a golden-set regression suite that skips until a dataset and baseline are pinned; the integration ones need the database up |
| `npm run typecheck` | `tsc --noEmit` across every workspace |

## Configuration

Everything is in `.env`; `.env.example` documents each key. The three that
change behaviour most:

- **`AGENT_MODE`** — `shadow` (classify and draft, send nothing), `assist`
  (drafts wait in the review queue), `auto` (per-category autonomy applies).
- **`OUTBOUND_EMAIL_PROVIDER`** — `spool` writes real messages to a folder and
  is the development default, `smtp` and `postmark` deliver, `none` records and
  sends nothing. See [Outbound mail](#outbound-mail).
- **`EMBEDDING_PROVIDER`** — `hash` is a deterministic local embedder so the
  pipeline runs with no key and no network. It is real lexical similarity, not
  noise, but it is not semantic. Use `openai` for anything real.
- **`LLM_DAILY_COST_CAP_USD`** — per-tenant daily ceiling. Exceeding it fails
  calls loudly rather than degrading quietly.

### SLA clocks

Two clocks per ticket — first response and resolution — stamped when the ticket
is triaged, from the tenant's policy for that priority. A P1 runs on calendar
time because an outage at 2am does not get to wait until nine; a P4 runs on
business hours because a licence request raised at 4:55pm on Friday should not
breach over the weekend.

**The clock stops while you are waiting on the requester.** A ticket that enters
`awaiting_user` has its pause stamped; when it leaves — because the requester
replied, or somebody resolved it — the deadline and warning instant of every
clock still running move forward by the time it waited, measured in the units
that clock runs in. A business-hours ticket that waits from Friday afternoon to
Monday morning is credited three working hours, not sixty-four calendar ones.
Repeated cycles accumulate into `sla_paused_minutes`, which is the honest answer
to "how much of this ticket's age was ours".

A result already recorded does not move. A first response sent before the pause
keeps its deadline. One sent during the pause is credited only the wait before
it, at the moment it is sent, so it reads the same before and after the
requester replies.

A paused ticket shows `paused` rather than a countdown that is not counting
down, and the warning sweep skips it. A deadline that had already gone past
when the clock stopped still reports `breached`, because a pause cannot undo
one. A deadline that passes while the clock is stopped does not, because that
time is about to be given back. Every state and transition, with the test that
pins each one, is in [docs/sla.md](docs/sla.md).

**A breach is history once it happens.** The first write or sweep that sees a
clock breach records the deadline it missed in `first_response_breached_at` or
`resolution_breached_at`, with an `sla_breach` event, and nothing clears it.
Every write that can move a deadline records first, so a downgrade cannot hide a
breach that nobody had recorded yet, and a breached clock reads `breached` from
then on. A reopen starts a new resolution clock and leaves the old one's breach
where it was.

**"Due soon" has one definition.** `warningLeadMinutes` takes a share of the
window (`sla_warning_at_percent`, 20% by default), `computeSla` applies it once,
and the instant is stored on the ticket. The console, the portal, the API and
the warning email all compare against that same column — so 20% of a
fifteen-minute P1 is three minutes and 20% of a three-day P4 is most of a
working day, and nothing disagrees about which tickets are at risk.

`PORTAL_SECRET` signs requester portal links *and* the unsubscribe links in
notifications; rotating it invalidates every link of both kinds already issued.
The two purposes are domain-separated inside the signature, so an unsubscribe
link is not also a capability for that person's ticket history. `APP_BASE_URL`
is where links in outbound mail point. Rate limits and the redaction switch live per tenant in
`businesses.settings`, not in `.env`, because they are a property of the tenant
rather than of the deployment.

## What is real and what is stubbed

Real: the schema, intake and deduplication, email threading and merge,
enrichment, triage, retrieval and supersession, the decision branch, the risk
gate and approval queue, the event log, writeback, follow-up, metrics, the SLA
clocks, secret scrubbing and PII redaction, the injection scanner, the rate
limiter, the requester portal, and every SQL statement in the agent path (there
is an integration test that drives the pipeline against a live Postgres).

Also real: outbound email and the notifications built on it. Messages are
queued as rows, delivered by a worker over SMTP or the Postmark API, retried
with backoff, dead-lettered when the attempt budget runs out, and reconciled
against bounces and complaints. The development transport writes the rendered
message to a folder rather than sending it, and says so on every row it touches
— a `spool` in the provider column is never mistakable for a delivery.
Assignment, SLA warning, escalation, approval and resolution notices each have a
template, a tenant setting, a deduplication key and a working unsubscribe
link.

Stubbed, and it says so at runtime: the write calls to Entra/Okta/Google and the
MDM. Those return `{simulated: true}` with a note rather than pretending to have
granted access — phase 5 starts read-only on purpose, and a stub that announces
itself is safer than one that does not.

Console authentication is real: scrypt password hashing from the standard
library, server-side sessions that can be revoked, role-based permissions
checked in the data layer, and an audit log carrying actor, tenant, old value,
new value, reason, request id and IP. The intake webhook takes its tenant from
a per-tenant token rather than from the request body.

So is the REST API, and so are the health checks. API keys are hashed, carry a
role from the same grant table the console uses, are revocable in a column, and
name the tenant themselves — there is no `business_id` parameter in `/api/v1` to
get wrong. Each of the seven health checks makes a real call to the thing it
reports on, and worker liveness is the age of a heartbeat rather than a status
anybody wrote, because a crashed process cannot report its own death.

Portal links are HMAC capability URLs — unguessable, scoped to one requester,
revocable in bulk by rotating the secret — which is the right shape for "tell me
about my own ticket" and is deliberately not the console's authentication.

Approvals expire. A queued action carries a deadline from
`approval_expiry_hours`, and an expired one can be neither approved nor
executed — the risk gate verifies the tenant, the status, the deadline and the
exact arguments that were approved, rather than trusting that an approval id was
supplied.

Not built: Slack and Teams intake, IMAP polling, CSAT collection, and SSO.
Password policy is a 12-character minimum and nothing
else — no lockout, no MFA, no rotation — which is adequate for an internal
console behind a VPN and is not adequate for the open internet.
