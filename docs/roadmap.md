# Roadmap

The expanded feature list, audited against the code rather than copied into a
table. Every row below was checked against the repository on 2026-09-14.

**Legend** — `Built`: working and, where it matters, tested. `Partial`: the
substrate exists but the feature does not, and the gap is named. `—`: not
started.

A roadmap that lists shipped work as todo is worse than no roadmap, so the
status column comes first and the phase column second.

---

## What the audit found

Of the 255 features now listed — 244 from the expanded list, five rows section
13 had folded together or left out, and six the outbound transport made real
enough to be worth their own rows: **69 are built**, 57 are partial — the
substrate exists but the feature does not — 5 are registered tool stubs awaiting
a provider client, and 124 have not been started. Per-section counts are under
each table.

The evaluation harness (section 13) is built and is the reason ten of those rows
moved. Outbound mail (sections 1, 9 and 16) moved eight more, and the
notifications built on top of it moved another seven — section 9 has gone from
nothing to thirteen of fifteen in two blocks, which is what a transport being
the bottleneck looks like from the other side.

Five things worth reading before the tables.

**1. The build is deep on agent safety and shallow on platform basics.**
Prompt-injection defence, PII redaction, secret scrubbing, rate limits, the
risk-tier gate and the approval queue are all built and tested.

RBAC and tenant-isolation tests were the largest remaining gap and are now
built: roles and permissions, server-side sessions, a `TenantContext` every
repository requires, a configuration audit log, and 77 cross-tenant attack
tests. The last two P1 rows — a REST API and health checks — are built as well,
and the two exit criteria that were still unproven now hold: a replay
reconstructs a ticket from `ticket_events` alone, and intake latency has been
measured at ten times the volume this build models. **P1 is met on its own
terms** — every feature exists and every line the gate names has been
demonstrated rather than asserted.

**2. A meaningful slice of the list is already done.** Production shadow mode
is listed at P4 and has been the default since phase 2. Business-hours-aware
SLA, prompt-injection detection, sensitive-field masking, the human correction
feedback loop, persistent conversation memory, agent confidence explanation and
"why did the agent choose this" are all built. Counts are at the bottom of each
section.

**3. Evaluation moved to the front, and is now built.**
`triage_shadow` has collected `(confidence, agent_category, human_category)` on
every ticket in every mode since phase 2, into a table nothing read. `@hd/eval`
reads it: accuracy per category, precision/recall/F1, calibration and expected
calibration error, a Wilson-bounded threshold sweep, and a regression gate
against a pinned baseline. `npm run eval score` answers, from data rather than
from judgement, which thresholds in `businesses.settings` are defensible — and
says `insufficient data` for the ones that are not yet.

**4. "Don't let the model decide tool permissions dynamically" is already the
architecture.** `actions.ts` maps a classified category to at most one candidate
tool; the tenant whitelist decides whether it runs; destructive tools cannot be
whitelisted at all. It is written up in [decisions.md](decisions.md) under
"Tools are chosen by table, not by the model". No change needed — but it is
worth keeping the constraint stated, because the pressure to relax it arrives
with the first multi-step workflow.

**5. Two concrete loose ends the list surfaced, both still open.**
`ApprovalStatus` includes `expired` and nothing ever sets it, so approvals are
currently immortal. And there is no configuration audit log: you can replay why
the agent closed a ticket, but not who widened a category's autonomy on Friday
afternoon. The second one directly contradicts the reasoning in decisions.md
for putting autonomy in the database, and it is the first thing built after
this harness.

---

## Exit criteria per phase

The important change from the feature list: a phase is not complete when its
features exist, it is complete when its numbers hold. These are the gates.

### P1 — Foundation

Complete when the platform can be handed to someone else.

- Every table carries `business_id`, and an automated test proves a query
  scoped to tenant A returns zero rows written by tenant B. Not a code review —
  a test that fails if someone drops a `where`. **Done**:
  `packages/core/test/isolation.test.ts` builds two tenants and attacks each
  from the other across tickets, events, requesters, devices, staff, the
  knowledge base, users, memberships, approvals, settings, credentials,
  analytics, the audit log, sessions, the outbound mail queue, API keys and the
  API request log.
- No action is attributed to a constant. `human:console` appears nowhere in the
  audit trail; every console write carries a real subject from a session.
  **Done**, and `packages/core/test/tenant-scoping.test.ts` fails the build if
  the string comes back.
- `/healthz` reports database, Redis and queue liveness, and the worker
  publishes a heartbeat visible to the console. **Done**: seven checks that each
  touch the thing they claim to check, a `/readyz` narrowed to the dependencies
  that should drain an instance, and a System page in the console reading the
  same report with the detail left in.
- A ticket's full history reconstructs from `ticket_events` alone, with no
  state that exists only as a column. **Done**:
  `packages/core/test/replay.integration.test.ts` folds the event log into a
  state object without reading the ticket row once, and compares the result
  against the columns — status, category, priority, confidence, assignee, first
  response, resolution and paused time — across a full lifecycle, a human
  override, a reopen, and events sharing a millisecond.
- p95 intake → enqueued under 2s at 10× current volume. **Done**:
  `npm run bench:intake` times the whole of `intakeMessage` — dedupe, identity,
  threading, scrubbing, insert, opening event and enqueue. 500 messages at
  concurrency 20 gives **p95 67ms**; 2,000 at concurrency 50 gives **p95 237ms**
  at 303/s, no failures. Nothing states a current volume, so the harness assumes
  ~100 tickets a day for a tenant of this size: 10× is 1,000 a day, and the
  default run delivers that in under two seconds.

### P2 — Intelligent Triage

Complete when the classifier's confidence means something. Every line below is
a gate `npm run eval score` checks and names; `unmeasured` is not a pass.

- **A reviewed golden set** of at least 100 tickets, covering every category
  and every security/destructive flag, held out of all prompt iteration.
  Reviewed, not exported: a console correction is evidence, not ground truth.
  **Drafted, not reviewed**: `eval/golden-set` holds 100 cases, lint clean,
  every category covered and both sides of every safety flag — and 0 of them
  accepted. A draft is a proposal whatever wrote it, so this line stays open
  until a person has read them. `npm run eval golden` prints the count.
- **All production triage has measurable outcomes** — ≥ 90% of triaged tickets
  carry a human classification, so the accuracy below describes the traffic
  rather than whichever slice people found interesting.
- Classification accuracy ≥ 90% overall on the held-out set, and ≥ 85% for
  every category with 20 or more labelled tickets. One strong category can
  otherwise hide three weak ones.
- **False-routing rate measured and ≤ 5%** under the thresholds actually
  configured: of the tickets autonomy would have handled unattended, the share
  that reach the wrong team. This, not accuracy, is the trust metric.
- **Thresholds are data-derived** — every configured threshold is supported by
  the observed data, or the gate names the ones that are not.
- **Regression evaluation runs automatically** — a pinned baseline exists and
  `npm run eval regress` gates model, prompt, taxonomy, routing and threshold
  changes against it.
- **Calibration error ≤ 0.05** in every confidence bucket with n ≥ 30: when the
  agent says 0.9 it is right 90% of the time. This is the number that makes the
  threshold in `businesses.settings` a measurement rather than a guess.
- Zero misses on the safety slice: no ticket that is security-sensitive or
  destructive is classified as neither, at any confidence.
- Human correction rate < 15% and falling across two consecutive weeks.
- Cost per triaged ticket tracked per tenant and inside budget.

### P3 — Knowledge Agent

Complete when the agent's answers are traceable.

- Retrieval recall@5 ≥ 85% on golden question → document pairs.
- **Groundedness ≥ 95%**: claims in a draft trace to a retrieved chunk. The
  remainder must be pleasantries, not facts.
- Citation validity 100%: no draft cites a document that was not retrieved or
  does not exist.
- `no_kb_support` fires on ≥ 90% of a deliberately unanswerable set.
- Zero leaks of a scrubbed class into a prompt or an embedding, measured on a
  red-team corpus, not on the happy path.
- Injection suite passes 100% of known vectors, and new vectors are added to it
  every time one is found in the wild.

### P4 — Autonomous Support

Complete when autonomy is earned per category, not switched on globally.

- Per category being enabled: accuracy ≥ 95% at the chosen threshold, sustained
  over two weeks of shadow traffic, n ≥ 100.
- **False resolve rate < 2% and not trending up.** This is the trust metric; it
  gates the phase regardless of how good deflection looks.
- A canary at 10% of eligible tickets for one week with no regression against
  the shadow baseline.
- Automatic rollback on quality degradation demonstrated in a drill, not just
  implemented.
- Kill switch verified end to end: flipping `AGENT_MODE` stops outbound contact
  within one ticket, and the drill is repeated after every deploy that touches
  the decision branch. Since mail is queued rather than sent inline, this means
  the queue too: the delivery loop re-checks the effective mode and cancels an
  agent's reply that was queued before the switch moved.

### P5 — Agentic Actions

Complete when every write is reversible, attributable and rehearsed.

- Every write tool has a dry-run path, a post-action verification step and an
  idempotency key. No tool ships with two of the three.
- Rollback proven for every tool whose provider supports it; tools whose
  provider does not are documented as one-way and stay behind approval.
- 100% of executed actions carry either an approval record or a whitelist
  entry. Unattended destructive actions: zero, enforced by test.
- Approval expiry enforced — no approval older than the tenant's window can be
  actioned.
- Action failure rate < 1%, and every failure leaves the system in a state the
  audit log explains.

### P6 — Enterprise / Scale

- DR drill executed against stated RTO/RPO, not a documented intention.
- CSAT collected on ≥ 30% of resolutions and segmented by resolution type.
- Slack/Teams reach parity with email through the *same* intake path — a second
  normalizer is how channels drift apart.

---

## 1. Intake & channels

| Feature | Status | Phase | Note |
|---|---|---|---|
| Quoted-text removal | **Built** | P1 | `stripQuotedHistory`, 4 tests; Outlook, Gmail and mobile markers |
| Auto-signature removal | Partial | P1 | Only via the `Sent from my` marker; no signature-block detection |
| Ticket source tracking | **Built** | P1 | `source` on every ticket; email, portal, api |
| Out-of-office / auto-generated detection | **Built** | P2 | `isAutoReply`, 2 tests — the classic inbox loop |
| Email bounce/failure handling | **Built** | P2 | DSN and abuse reports parsed and matched to the message, hard bounces and complaints suppress the address, the ticket reopens; 11 tests |
| Requester identity verification | Partial | P2 | Resolved by email; *proving* the sender is who they claim is not built, and a password-reset agent needs it |
| Forwarded-email detection | — | P2 | The requester is then the forwarder, not the person with the problem |
| Conversation-to-ticket conversion | — | P2 | Needs a chat channel first |
| Attachment malware scanning | — | P3 | Attachments are captured as filenames only; nothing opens them |
| Language normalization | — | P3 | |
| Multi-request splitting | — | P3 | |

Built 4 · Partial 2 · Not started 5

## 2. Triage & intelligence

| Feature | Status | Phase | Note |
|---|---|---|---|
| Intent classification | **Built** | P2 | Category + subcategory, structured output |
| Agent confidence | **Built** | P2 | Scored, thresholded per category, shown against its threshold |
| Entity extraction | Partial | P2 | `affected_system` only; no device, location or error-code extraction |
| Duplicate similarity scoring | Partial | P2 | Incident hint + a conservative SQL heuristic; no embedding similarity |
| Historical-resolution matching | **Built** | P3 | Writeback puts resolutions in the KB where retrieval finds them |
| Impacted-service detection | Partial | P3 | `affected_system` is a name, not a service record |
| Business-impact estimation | Partial | P3 | Priority is impact-based by definition; nothing quantifies it |
| Recommended resolver prediction | Partial | P3 | Routes to `tier1`/`oncall` by priority; no skill match |
| Root-cause hypothesis | — | P3 | |
| Sentiment detection | — | P3 | |
| Dependency detection | — | P3 | Needs a service graph |
| Frustration / escalation risk | — | P4 | |
| SLA-breach prediction | — | P4 | Clocks are computed, not forecast |
| Resolution probability | — | P4 | |

Built 3 · Partial 5 · Not started 6

## 3. Incident management

| Feature | Status | Phase | Note |
|---|---|---|---|
| Incident linking | **Built** | P3 | `known_incident` rule links and acknowledges rather than opening duplicate 40 |
| Incident creation from related tickets | Partial | P3 | Incidents exist and link; clustering tickets *into* a new incident does not |
| Incident timeline | Partial | P4 | Per-ticket event log exists; no incident-level roll-up |
| Incident communication draft | Partial | P4 | `incidentAck` writes to one requester; no broadcast |
| Major incident detection | — | P4 | |
| Incident commander recommendation | — | P4 | |
| Impacted-user estimation | — | P4 | |
| Service dependency graph | — | P4 | |
| Major incident status updates | — | P4 | |
| Post-incident summary | — | P6 | |
| RCA assistant | — | P6 | |
| Problem record from recurring incidents | — | P6 | |

Built 1 · Partial 3 · Not started 8

## 4. Knowledge & RAG

| Feature | Status | Phase | Note |
|---|---|---|---|
| Retrieval confidence monitoring | **Built** | P3 | `kb_top_score` on every decision; `kb_support_floor` per tenant |
| "No reliable answer" detection | **Built** | P3 | Rule 11, `no_kb_support` — confident with no source is the fluent-wrong-answer setup |
| Tenant-specific KB sources | **Built** | P3 | Partitioned by `business_id` and origin |
| Source freshness | Partial | P3 | Supersession excludes stale chunks; freshness does not affect ranking |
| RAG citation validation | Partial | P3 | Sources recorded on every draft; not validated against the answer text |
| Answer groundedness check | — | P3 | The P3 exit gate above depends on this |
| Duplicate KB detection | Partial | P4 | Content hash stops re-ingesting an unchanged file; semantic duplicates survive |
| KB quality scoring | — | P4 | |
| KB ownership | — | P4 | |
| KB approval workflow | — | P4 | |
| KB expiration / review date | — | P4 | |
| Conflicting-document detection | — | P4 | |
| Knowledge graph | — | P6 | |
| FAQ generation | — | P6 | |
| KB usage analytics | — | P6 | |

Built 3 · Partial 3 · Not started 9

## 5. Agent reasoning & conversation

| Feature | Status | Phase | Note |
|---|---|---|---|
| Persistent conversation memory | **Built** | P1 | The ticket conversation ([conversation.md](conversation.md)), with `Message-ID` threading, and `ticket_events` as its audit log |
| Short-term conversation state | **Built** | P1 | `clarify_count`, `awaiting_user` |
| Agent confidence explanation | **Built** | P2 | Confidence against its category threshold, on the ticket page |
| "Why did the agent choose this?" | **Built** | P2 | Rule, reason, and the counterfactual it would have run at full autonomy |
| "Why did the agent escalate?" | **Built** | P4 | Same panel plus the escalation summary handed to the human |
| Context-window management | Partial | P3 | History stripped, system prefix cached; no explicit budget or compaction |
| "What has already been tried?" | Partial | P3 | The event log holds it; nothing extracts it into the prompt |
| Conversation summarization | — | P3 | |
| Adaptive troubleshooting | Partial | P4 | One clarify round, budgeted per tenant; not a dialogue |
| Conversation timeout | Partial | P4 | 24h follow-up on resolved; `awaiting_user` never times out |
| Troubleshooting decision tree | — | P4 | |
| User confirmation before risky steps | — | P4 | The approval gate covers agent actions, not steps the user performs |
| Contradictory-information detection | — | P4 | |

Built 5 · Partial 4 · Not started 4

## 6. Automation & actions

The constraint from the feature list — permissions stay deterministic, the
model never chooses them — is already enforced and should be treated as
load-bearing when multi-step workflows arrive.

| Feature | Status | Phase | Note |
|---|---|---|---|
| Tool-call authorization | **Built** | P5 | Registry, five risk tiers, per-tenant whitelist, destructive never whitelistable |
| Action execution history | **Built** | P5 | `logToolCall` plus `tool_call` events with args and outcome |
| Pre-action validation | Partial | P5 | Zod schema per tool; no semantic pre-checks |
| Action simulation / dry-run | Partial | P5 | Write tools return `{simulated: true}` because they are unimplemented — that is a stub, not a dry-run mode |
| Failed-action retry policy | Partial | P5 | Queue-level retry with backoff, and a per-message policy with a dead-letter queue for outbound mail; identity and MDM writes still have neither |
| Post-action verification | — | P5 | Nothing confirms the account actually unlocked |
| Automatic rollback | — | P5 | |
| Idempotency keys | Partial | P5 | `outbound_messages` dedupes on `(business_id, idempotency_key)`, so a double-clicked Send is one email; identity and MDM writes still have none |
| Action timeout | — | P5 | |
| Dependency-aware execution | — | P5 | |
| Multi-step workflow | — | P5 | One candidate action per ticket today |
| Before/after state comparison | — | P5 | |
| Scheduled actions | — | P6 | |
| Bulk remediation with approval | — | P6 | |

Built 2 · Partial 4 · Not started 8

## 7. Human-in-the-loop

| Feature | Status | Phase | Note |
|---|---|---|---|
| Human correction feedback loop | **Built** | P2 | Correction and confirmation both write ground truth to `triage_shadow` |
| Human edits AI response before sending | **Built** | P3 | Editable draft, then send and resolve |
| AI recommendation vs human decision analytics | **Built** | P4 | Calibration overall and per category |
| Human rejection reason capture | — | P2 | The correction is captured, the *why* is not — and the why is the training signal |
| Approval reason requirement | Partial | P5 | Requester rationale recorded; approver reason not required |
| Human takeover | Partial | P4 | Assign and set status exist; no explicit "agent stops touching this" |
| Agent performance by team/category | Partial | P6 | By category yes, by team no |
| **Approval expiry** | — | P5 | `ApprovalStatus` has `expired` and nothing sets it — approvals never age out |
| Approval delegation | — | P5 | |
| Multi-level approval | — | P5 | |
| Emergency approval | — | P5 | |
| Human-agent collaboration notes | — | P4 | No internal note UI |

Built 3 · Partial 3 · Not started 6

## 8. SLA & queue management

| Feature | Status | Phase | Note |
|---|---|---|---|
| SLA countdown per ticket | **Built** | P1 | Two clocks, shown in the queue and the portal |
| Business-hours-aware SLA | **Built** | P3 | Calendar time for P1, business hours below it, DST-correct |
| SLA breach warning | **Built** | P3 | `slaStatus` drives the queue display, and a sweep emails the assignee or the queue at a configurable share of the window |
| Skill-based routing | Partial | P3 | `staff.queue` exists; no routing logic reads it |
| Escalation policy engine | Partial | P4 | The decision branch plus a queue name; not configurable per tenant |
| Holiday calendar | — | P3 | Business hours exist; holidays do not, so December SLAs will be wrong |
| SLA breach prediction | — | P4 | |
| Automatic priority escalation | — | P4 | |
| Queue load balancing | — | P4 | |
| Agent workload prediction | — | P4 | |
| Availability-aware assignment | — | P4 | `staff.active` is the whole model |
| SLA exception tracking | — | P5 | |

Built 3 · Partial 2 · Not started 7

## 9. Notifications

Built, in two blocks. The transport came first — mail rendered, queued as a
row, delivered by a worker, retried, dead-lettered, reconciled against bounces,
visible at `/mail` — and the five rows describing that machinery are listed
explicitly, because "notifications" as a set of message types was hiding it.

Then the notifications themselves: assignment, SLA warning, escalation,
approval and resolution, each with a template, a tenant setting, a deduplication
key and an unsubscribe link. Consent lives in two places on purpose. Tenant
policy is in `businesses.settings`, versioned and audited like any other
configuration, and silencing the master switch or the approval notice is
classified as a *widening* change because it reduces human oversight of the
agent. An individual's opt-out is a row in `notification_optouts` instead — a
fact about a person rather than a setting of the tenant, so a configuration
rollback cannot resubscribe somebody who unsubscribed yesterday.

What is left is the two P6 rows, both of which need a channel this system does
not have yet.

| Feature | Status | Phase | Note |
|---|---|---|---|
| **Outbound email delivery** | **Built** | P3 | `spool` for development, SMTP through a nodemailer pool, or the Postmark API |
| **Delivery status tracking** | **Built** | P3 | Seven statuses on the row, every transition in `outbound_message_events` |
| **Retry with backoff and a dead-letter queue** | **Built** | P4 | Jittered exponential backoff, attempt budget per message, `/mail` shows the dead letters and retries them |
| **Notification audit trail** | **Built** | P4 | Per-message history, plus `notification.*` audit rows for what a person decided |
| **Bounce and complaint handling** | **Built** | P4 | Inbound DSNs and a per-tenant provider webhook; hard bounces and complaints suppress the address |
| Notification deduplication | **Built** | P4 | `(business_id, idempotency_key)`: the same words on the same ticket are one email; per kind, once an hour per person, or once per clock for an SLA warning |
| **Email notification preferences** | **Built** | P3 | A signed unsubscribe link in every staff notification, no login needed; the opt-out is per address and per kind, or `all` |
| **Notification preference per tenant** | **Built** | P4 | Six toggles plus the SLA warning threshold and a fallback address, in `businesses.settings`; two of them are classified critical |
| **Assignment notification** | **Built** | P3 | To the person who got the ticket, with a digest above a handful so a bulk reassignment is one email rather than forty |
| **SLA warning notification** | **Built** | P4 | A sweep every five minutes, warning at a share of each ticket's own window; the assignee, else the queue, else recorded as nobody |
| **Escalation notification** | **Built** | P4 | To the queue the agent handed it to, with the suggested fix labelled unverified |
| **Approval notification** | **Built** | P5 | To whoever holds `action:approve`, with the deadline in it — the gap that made an expiring approval look like a refusal |
| **Resolution notification** | **Built** | P4 | To the requester when a person resolves it, threaded onto their conversation, and skipped when a reply has just gone out |
| Slack/Teams notifications | — | P6 | Needs the channel first; the P6 gate says it must come through the same intake path |
| Incident broadcast | — | P6 | One-to-many, which is a different shape from everything above |

Built 13 · Partial 0 · Not started 2

## 10. Admin & configuration

| Feature | Status | Phase | Note |
|---|---|---|---|
| Tenant-specific KB sources | **Built** | P3 | |
| Tenant feature flags | Partial | P2 | `businesses.settings` is per-tenant config; no flag system or rollout control |
| Custom ticket fields | Partial | P3 | `metadata` jsonb, unvalidated and unrendered |
| **RBAC** | **Built** | P1 | 6 roles, 23 permissions, `role -> permissions` in one table |
| Permission groups | Partial | P2 | Roles group permissions; no custom groups per tenant |
| Category configuration UI | **Built** | P3 | `/settings`, audited, `security:update` for autonomy |
| Routing-rule builder | — | P3 | |
| Custom statuses | — | P3 | Status is a Postgres enum |
| Custom escalation policies | — | P4 | |
| Tenant-specific prompts | — | P4 | Prompt registry is global and versioned |
| **Configuration audit log** | — | P4 | You can replay why a ticket closed but not who widened autonomy |
| Configuration versioning | — | P4 | |
| Configuration rollback | — | P4 | |
| Workflow builder | — | P5 | |
| Action policy builder | — | P5 | |

Built 1 · Partial 2 · Not started 12

## 11. Analytics

| Feature | Status | Phase | Note |
|---|---|---|---|
| Deflection, escalation, false-resolve, median times | **Built** | P2 | `headlineMetrics`; false-resolve is the one the page tells you to watch |
| Calibration by confidence bucket | **Built** | P2 | Bucket → accuracy → human correction rate, with ECE against its gate |
| Tenant AI cost dashboard | Partial | P2 | `llm_usage` and `spendByDay` exist; no per-tenant dashboard view |
| Cost per resolved ticket | Partial | P2 | Cost is logged per event, not rolled up per outcome |
| Cost per escalated ticket | Partial | P2 | Same rollup |
| Resolution time by category / team / priority | Partial | P3 | Median overall only |
| KB retrieval success rate | Partial | P3 | `kb_top_score` logged on every decision; no metric over it |
| Action failure rate | Partial | P5 | Data is in `tool_call` events |
| Approval rejection rate | Partial | P5 | Data is in the approvals table |
| Repeat-contact rate | Partial | P4 | `reopened_count` exists |
| AI vs human resolution comparison | Partial | P4 | Calibration covers classification, not resolution quality |
| RAG citation accuracy | — | P3 | |
| Hallucination rate | — | P4 | Needs the groundedness check from P3 |
| Reopen reason analysis | — | P4 | |
| Automation success rate | — | P5 | |
| CSAT by resolution type | — | P6 | No CSAT collection |
| AI ROI dashboard | — | P6 | |

Built 2 · Partial 9 · Not started 6

Most of this section is a rollup problem rather than an instrumentation
problem: the events carry cost, latency, model, tokens and outcome already.

## 12. Security & governance

| Feature | Status | Phase | Note |
|---|---|---|---|
| Prompt-injection detection | **Built** | P3 | Scanner plus four defence layers; escalates rather than acting |
| PII detection and redaction | **Built** | P3 | In transit, before model and before embedding |
| Secrets never exposed to model | **Built** | P3 | Scrubbed at rest at intake, before the row is inserted |
| Sensitive-field masking | **Built** | P3 | `redactPayload` |
| Tool-call authorization | **Built** | P5 | |
| Audit-log tamper protection | **Built** | P4 | Database triggers refuse update and delete, including from the application's own connection; no hash chain yet |
| Model input/output logging policy | Partial | P3 | Events carry model, tokens, cost; no policy switch for prompt retention |
| Excessive-action detection | Partial | P5 | Rate limits count agent runs, not actions |
| Tenant-specific security policies | Partial | P5 | Whitelist, VIP and department routing per tenant |
| **RBAC/ABAC authorization** | **Built** | P1 | Permission checks in the repository, not the route |
| **Tenant isolation tests** | **Built** | P1 | 77 cross-tenant assertions, plus structural checks that run without a database |
| Encryption at rest / in transit | — | P1 | A deployment concern with no configuration in the repo |
| Data retention policies | — | P4 | |
| Ticket deletion / anonymization | — | P4 | Tension with the append-only log; resolve it deliberately |
| Credential vault integration | Partial | P5 | `integration_credentials`, AES-256-GCM at rest, `credentials:read` audited; no external vault |
| Tool-output validation | — | P5 | Provider responses are trusted today |
| GDPR / privacy request workflow | — | P6 | |
| Anomalous agent behaviour detection | — | P6 | |
| Data residency | — | P6 | |

Built 5 · Partial 4 · Not started 10

## 13. AI evaluation

Was the correctly-identified gap, and is the slice that got built first: the
*data* for most of it already existed and nothing read it. `@hd/eval` now does,
with `npm run eval`.

| Feature | Status | Phase | Note |
|---|---|---|---|
| Production shadow mode | **Built** | P4 | Already the default; the counterfactual is recorded in every mode |
| Automated classification evaluation | **Built** | P2 | `@hd/eval` — accuracy, per-class precision/recall/F1, confusions, over `triage_shadow` or a frozen set |
| False-routing rate + coverage | **Built** | P2 | Misroutes as a share of what autonomy would have handled, under the configured thresholds |
| Per-ticket result store | **Built** | P2 | `eval_runs` / `eval_results`, insert-only, sliceable by tenant / category / bucket / prompt version |
| Configuration fingerprint | **Built** | P2 | Model, prompt, taxonomy, routing and thresholds hashed; a changed fingerprint is reported as a different configuration, not a delta |
| Confidence calibration + ECE | **Built** | P2 | Fixed-width buckets, ECE, worst-bucket gap, Brier; thin buckets shown but excluded from the gate |
| Threshold recommendation | **Built** | P2 | Wilson-lower-bound sweep per category, against the configured threshold |
| **Golden ticket dataset** | **Built** | P2 | JSONL in `eval/datasets`, hash-stable split, reviewed/candidate/rejected with labeler and label version |
| Evaluation dashboard | **Built** | P2 | Analytics page renders the same report the CLI gates on: gates, bucket → correction rate, recommendations |
| Regression testing for prompts | **Built** | P2 | Pinned baselines with per-metric tolerances; refuses to compare across datasets; zero tolerance on safety |
| Offline evaluation before deployment | **Built** | P2 | `npm run eval replay` re-runs triage over the frozen set with the current prompt and model |
| Safety evaluation suite | Partial | P3 | 30 tests enumerate the decision branch — policy, not model behaviour. The model-side safety slice exists and reads `unmeasured` until tickets are labelled |
| Prompt-injection test suite | Partial | P3 | 9 tests on the fencing; no adversarial corpus |
| RAG retrieval evaluation | — | P3 | The metrics layer is reusable; the golden question → document pairs are not collected |
| Answer correctness evaluation | — | P3 | |
| Citation correctness evaluation | — | P3 | |
| Model A/B testing | Partial | P4 | `replay --model` scores one model over a fixed set; nothing splits live traffic |
| Prompt A/B testing | Partial | P4 | Same: sequential comparison against a baseline, not a live split |
| Threshold A/B testing | — | P4 | |
| Canary rollout | — | P4 | |
| Automatic rollback on degradation | — | P4 | |
| Tool-call accuracy evaluation | — | P5 | |

Built 11 · Partial 4 · Not started 7

## 14. Model & LLM management

| Feature | Status | Phase | Note |
|---|---|---|---|
| Model selection per task | **Built** | P3 | `TRIAGE_MODEL` and `DRAFT_MODEL` are separate |
| Embedding model configuration | **Built** | P3 | Including a deterministic local embedder for dev and tests |
| Response caching | **Built** | P3 | Prompt caching on the system prefix; cache tokens tracked per call |
| Model version tracking | **Built** | P4 | Recorded on every event |
| Prompt version tracking | **Built** | P4 | Registry, and `prompt_version` on every triage event |
| Small model for classification | Partial | P2 | Configurable and effort-tuned; defaults are not split by size |
| Larger model for troubleshooting | Partial | P4 | Same |
| Context compression | Partial | P3 | Quoted history stripped; no compaction |
| Model performance monitoring | Partial | P4 | Latency, tokens and cost per call; no monitoring over them |
| Model cost optimization | Partial | P4 | Caching, effort levels and a daily cap |
| **Token budget per ticket** | — | P2 | The cap is per tenant per day; one pathological ticket can spend it |
| Model fallback | — | P4 | |
| Provider fallback | — | P4 | |
| Model timeout handling | — | P4 | |

Built 5 · Partial 5 · Not started 4

## 15. Developer & platform

| Feature | Status | Phase | Note |
|---|---|---|---|
| Event-driven architecture | **Built** | P1 | Append-only log plus queue |
| Environment management | **Built** | P1 | Parsed, validated, documented |
| Background job queue | **Built** | P2 | BullMQ, three queues |
| Retry / dead-letter | **Built** | P3 | 3 attempts, exponential backoff, failures retained on purpose |
| Event replay | Partial | P1 | Events are replayable data; no replay mechanism |
| API authentication | **Built** | P1 | Hashed, revocable, role-carrying API keys; a shared secret per tenant on the intake and delivery webhooks |
| Centralized logging | Partial | P1 | Console, the event log and an API request log; no aggregation |
| Metrics / observability | Partial | P2 | Business metrics only; no system metrics or exporter |
| Feature flags | Partial | P2 | Per-tenant settings |
| Webhook framework | Partial | P2 | Inbound only; nothing outbound |
| API rate limiting | Partial | P4 | Per-key limits on the REST API, counted from the request log, plus the agent-run limits; the console and the webhooks are unlimited |
| **REST API** | **Built** | P1 | `/api/v1/tickets` list, read and create, keyed and tenant-scoped |
| **Health checks** | **Built** | P1 | `/healthz`, `/readyz`, worker heartbeats and a console System page |
| Distributed tracing | — | P3 | |
| Service dependency monitoring | — | P3 | |
| API versioning | — | P4 | |
| Backup / restore | — | P5 | |
| Disaster recovery | — | P6 | |
| High availability | — | P6 | |

Built 7 · Partial 6 · Not started 6

## 16. Integrations

| Integration | Status | Phase | Note |
|---|---|---|---|
| Entra ID / Azure AD | Stub | P2 | Registry entry, risk tier, honest `{simulated: true}` |
| Okta | Stub | P3 | Same |
| Google Workspace | Stub | P3 | Same |
| Microsoft 365 | Stub | P3 | Same |
| Outbound email (SMTP / Postmark) | **Built** | P3 | A connection-pooled SMTP transport or the Postmark API, with delivery events returning over a per-tenant webhook |
| CMDB / asset management | Partial | P5 | `assets` table and `primaryAsset` enrichment; no external sync |
| Intune / Jamf | Stub | P5 | MDM status reads and a wipe stub |
| ServiceNow | — | P5 | |
| Jira Service Management | — | P5 | |
| Freshservice | — | P5 | |
| Monitoring platforms | — | P5 | |
| Slack | — | P6 | |
| Microsoft Teams | — | P6 | |
| Zoom / Meet | — | P6 | |
| CrowdStrike | — | P6 | |
| Microsoft Defender | — | P6 | |
| Status-page providers | — | P6 | |

Built 1 · Partial 1 · Not started 10 · Stub 5

A stub here means the tool is registered, risk-tiered, permission-checked and
audited — everything except the provider call. Swapping in a real client is a
contained change, which is the point of the layer.

## 17. Advanced

Nothing started, correctly. Every row depends on the P1–P5 gates above holding,
and several depend on the service dependency graph that does not exist yet.

| Feature | Status | Phase | Note |
|---|---|---|---|
| AI-generated incident postmortem | — | P6 | Depends on the incident timeline that does not exist |
| Predictive incident detection | — | P6 | Needs monitoring integration first |
| Proactive ticket creation | — | P6 | The agent opening tickets nobody asked for raises its own consent questions |
| Automated recurring-issue detection | — | P6 | Closest to reachable — the data is in the ticket history |
| Service dependency intelligence | — | P6 | Blocks four other rows in this table |
| Predictive SLA breach prevention | — | P6 | Needs SLA prediction from P4 |
| Workforce capacity forecasting | — | P6 |  |
| AI-generated operational reports | — | P6 |  |
| Natural-language admin configuration | — | P6 | Config changes by prompt need the audit log from P2 first |
| Autonomous remediation for highly safe tasks | — | P6 | Only after P5's verification and rollback gates hold |
| Cross-system root-cause analysis | — | P6 |  |
| Self-improving routing policies with approval | — | P6 | A policy that edits itself needs config versioning and rollback |
| IT asset lifecycle prediction | — | P6 | Needs a real CMDB sync |
| Employee IT health score | — | P6 |  |

Built 0 · Partial 0 · Not started 14

The temptation to start this section early is the thing that kills these
projects.

---

## Build order

Agreed order, not the phase numbers. The list is 246 rows; the bottleneck is
not row count, it is proving the agent is correct, authorized and controllable.
Each block below is finished when the numbers under it hold.

### Done — evaluation harness

Consumes the existing `triage_shadow` records; no second data pipeline. A
reviewed golden dataset kept separate from production feedback, accuracy by
category, precision/recall/F1, confusion matrix, confidence calibration with
ECE against a ≤ 0.05 gate, false-routing rate and coverage, per-category
thresholds derived from observed data with a Wilson lower bound, per-ticket
results kept in `eval_runs` / `eval_results` for re-slicing, regression testing
against a pinned baseline with a configuration fingerprint, and a dashboard
showing confidence bucket → human correction rate. `npm run eval`.

It went first because it is the thing that makes every later autonomy decision
an argument from evidence rather than from taste, and because it retrofits
badly: the labels were already accumulating.

The P2 acceptance gate is the list under "P2 — Intelligent Triage" above, and
the harness reports it as a table. Nothing there is currently green on seeded
data, which is the correct state for a set that has not been labelled yet.

### Done — RBAC and tenant authorization

`human:console` is gone. Six roles, twenty-three permissions, and a grant table
feature code asks through `can(ctx, "config:update")` rather than testing a role
string. Sessions are server-side so they can be revoked; the tenant lives in the
session row, and switching it goes through a membership check, so no request
shape reaches another tenant.

The enforcement is in the data layer rather than in the routes. Every repository
function takes a `TenantContext` — a branded type that cannot be built from a
query string — and puts `ctx.businessId` in the predicate, so a cross-tenant id
matches no row instead of relying on a guard clause somebody remembered to
write. `packages/core/test/tenant-scoping.test.ts` fails the build when a new
function forgets.

### Done — configuration audit log

`audit_events` records actor, tenant, action, resource, old value, new value,
reason, request id, session and IP. Every settings change writes one row per
changed key. The autonomy-governing keys additionally require `security:update`
and a written reason, and a refused attempt is audited too — an attempt to widen
autonomy is worth more in the log than a successful ordinary edit.

### Done — configuration versions, rollback and change control

Every accepted change produces a numbered, immutable snapshot in
`config_versions`, plus one `audit_events` row per changed field, in one
transaction. Tickets are stamped with the version that decided them, so a replay
uses the configuration that actually applied rather than today's. Rollback
restores an earlier version by creating a new one — v17 set 0.82, v18 restores
0.90, and v17 stays in the history saying what it said.

Widening autonomy needs `security:update`, a reason, an acknowledgement of the
impact, and optionally a second administrator who is not the proposer. Narrowing
needs none of that, deliberately.

### Done — approval expiry

`expired` is set now, by a deadline stamped at creation from
`approval_expiry_hours`. `decideApproval` refuses a lapsed request in the same
statement that checks its status, so there is no window where a read said "still
fine" and the write disagreed.

The larger bug found while fixing it: the risk gate unlocked on
`Boolean(ctx.approvalId)`, so any non-empty string ran a destructive tool.
`checkApproval` now verifies tenant, status, deadline and the exact arguments
that were approved.

### Done — outbound email transport

The stub is gone. `ticket.send_reply` renders a real message — threaded,
tagged, addressed from the address the tenant receives on — writes it to
`outbound_messages`, and returns `queued`. A worker delivers it: claim, send,
retry with jittered backoff, dead-letter when the attempt budget runs out. The
row is the queue of record and the Redis job is a doorbell, so a Redis restart
delays a reply rather than losing it, and a message left in flight by a worker
that died is reclaimed after five minutes.

Three transports. `spool` renders to a folder and is the development default —
the whole path runs and no stranger receives a test email. `smtp` goes through a
nodemailer connection pool. `postmark` is one `fetch`, chosen because the
inbound webhook already speaks Postmark's payload shape, so a deployment can
point both directions at one account.

Failures come back by two routes and both are read. An SMTP deployment learns
about them as mail: a delivery status notification arriving at the intake
address, which used to be dropped as an auto-reply and is now parsed, matched to
the message by Message-ID and applied. An API deployment gets a webhook at
`/api/outbound/events`, authenticated per tenant, because a bounce quotes an
identifier that has travelled through a stranger's mail server and cannot be
treated as a capability. Hard bounces and complaints suppress the address for
that tenant; soft bounces are recorded and nothing else, because a delay notice
is the far side saying it is still trying.

Two consequences worth stating. A reply that never arrives no longer leaves a
ticket looking answered: the dead letter writes an `error` event and the ticket
goes back to `triaged`, which routes to a person. And the kill switch now
reaches the queue — an agent's reply that was queued in `auto` is cancelled if
the mode narrowed before it went out, which is what makes the P4 gate's "stops
outbound contact within one ticket" true rather than aspirational.

38 unit tests for the two judgements that matter — retry or give up, bounce or
ordinary mail — and 15 against a real database for the lifecycle: claim races,
deferral, dead-lettering, stall reclaim, per-tenant suppression, and a bounce
arriving after the ticket was resolved.

### Done — notifications and their preferences

Five notifications, and the consent machinery that stops them being spam.

`assignment` goes to the person who got the ticket — one email each up to a
handful, then a single covering note, because a bulk reassignment of forty
tickets is one decision and forty emails about it is how somebody learns to
filter this system into a folder they never open. `sla_warning` goes to the
assignee, or to the queue when there is no assignee, at a configurable share of
each ticket's *own* window: 20% of a fifteen-minute P1 target is three minutes
and 20% of a three-day P4 target is most of a working day, which a fixed "warn
30 minutes before" could never be right about at both ends. `escalation` goes to
the queue the agent handed the ticket to, with the suggested fix labelled
unverified. `approval` goes to whoever holds `action:approve`, with the deadline
in it — the gap that made an expiring request read, from the ticket, exactly
like a refusal. And `resolution` goes to the requester when a *person* closes
their ticket, threaded onto their existing conversation, skipped when a reply
has just gone out.

Consent is in two places and that is the decision worth defending. Tenant policy
sits in `businesses.settings`, versioned and audited like anything else, and two
of its fields — the master switch and the approval notice — are classified
critical, because silencing either reduces human oversight of the agent, which
this codebase already defines as a widening change. An individual's opt-out sits
in `notification_optouts` instead: it is a fact about a person, not a setting of
the tenant, and a configuration rollback to last week must not resubscribe
somebody who unsubscribed yesterday. Every staff notification carries two signed
links — stop this kind, stop everything — that work with no login, because the
people who most need them are the ones without a console account.

One authorization point. A manager may assign a ticket and does not hold
`action:execute`, so the notification is queued under a system context: it is a
consequence of an authorized action rather than a second privileged action by
that person. What keeps that safe is shape rather than a permission check — the
text comes from a closed union of templates and every recipient is resolved by a
tenant-scoped directory lookup, so there is no path from here to arbitrary words
sent to an arbitrary address. That path exists exactly once, in
`ticket.send_reply`, and it is gated.

39 tests with no database — templates, the token, and which settings the
configuration gate treats as safety controls — and 20 against a real one, for
the four questions between an event and a queued message: does this tenant send
this, has this person opted out, has it already gone, and who counts as the
queue.

### Done — health checks and the REST API

The last two P1 rows. Everything above them had an operational surface nobody
outside the process could see — three sweeps, a delivery queue with a
dead-letter list, and a worker whose silence was indistinguishable from health.

**Health is seven checks, and every one of them touches the thing it claims to
check.** A real query, a real Redis round trip, real queue depths, and the age
of a real heartbeat row. A check that reads configuration and reports `ok`
cannot fail, and a check that cannot fail is decoration with a green tick on it.
The worker's liveness is an *age* rather than a status, because a process cannot
be relied on to report its own death: nothing ever writes "stopped", the row
simply stops being updated, and a crash and an idle afternoon are separated by
the timestamp alone. Two of the checks are configuration and say so — no mail
transport and no model key are deliberate states, and "nothing has been sent all
week" has an explanation that nobody thinks of until a page states it.

**Three endpoints, because they are read by three different things.** `/healthz`
is public and therefore says names and statuses and nothing else — no error
text, no queue depths, no versions, because "cannot connect to postgres at
db-prod-3.internal:5432" is a free map of the deployment. `/readyz` is narrower
still: only the dependencies whose failure should drain an instance, so a
deployment sitting in shadow mode with no transport configured does not take
itself out of the load balancer. The console's System page is the same report
with the detail left in, for the person who needs to know *why*. The projection
lives in `health.ts` rather than in the routes, so a second route cannot get it
wrong.

**The REST API's tenant comes from the credential.** There is no `business_id`
parameter anywhere in `/api/v1`, and nothing in a URL, a query string or a body
can influence which tenant a request reads — the key names it, and every query
runs through the `TenantContext` that key produced. A key is a role, resolved
through the same grant table the console uses, so it is never more capable than
a person with that role and there is no second authorization model to drift from
the first. Only the hash is stored, `grantableRoles` stops an admin minting a
key that outranks the admin, and creating one needs `security:update` — the
permission that guards integration secrets, not the one that guards settings.

Creating a ticket goes through `intakeMessage`, the same door email and the
portal use, rather than inserting a row: deduplication, identity resolution,
threading and secret scrubbing are the same on every channel, and a second
create path is how the one that skips scrubbing gets written. Requests are
logged per key, which is both what the rate limiter counts and the only thing in
this schema that can answer "what has this credential been doing" — refusals
included, because a log holding only successes cannot show somebody probing. The
System page reads it back, so that question does not need SQL.

Ten tests with no database for the judgements — what counts as down, how stale a
heartbeat has to be, what an unauthenticated monitor may see, and a check that
the expected migration constant matches the highest-numbered file on disk so it
cannot rot quietly — and 11 against a real one: a key resolves to one tenant and
no further, a revoked or expired key resolves to nothing, an admin cannot mint
one at all, and the health verdicts come from real queries rather than from
configuration. The cross-tenant suite grew from 69 attacks to 77, the eight new
ones covering keys and the request log.

The split is deliberate and was worth one redesign. The staleness verdict
started inside the check that reads the heartbeat, which meant the only way to
observe `down` was for no worker to be running — a test that passed or failed
depending on what else the developer had open. It is now arithmetic on an age,
tested without a database, and the integration test asserts the part only a
database can prove: that the age is measured by the database clock, that a
restart updates the row rather than adding one, and that a clean shutdown
removes it.

### Done — the SLA clock, and closing the P1 gate

Two defects rather than two gaps, both of which made a number on screen wrong.

**The clock never stopped.** `computeSla` stamped both deadlines from
`created_at` and nothing moved them afterwards, so a ticket parked in
`awaiting_user` kept spending its resolution budget while the requester held the
ball. The resolution SLA was therefore measuring how quickly requesters answer
their email. `setStatus` now stops the clock on the way into that status and
gives the time back on the way out, in the units the clock runs in — a ticket
that waits from Friday afternoon to Monday morning is credited three business
hours, not sixty-four calendar ones. Repeated cycles accumulate, a duplicate
write cannot reset the pause, and the resume is guarded on the pause it read so
two requests cannot both shift the deadline.

**"Due soon" meant two different things.** The console decided it at
`Math.max(15, 0)` — a flat fifteen minutes, with a second argument nobody ever
filled in — while the warning sweep used a share of the window in SQL. A P4 with
a three-day target was `on_track` in the console and generating a warning email
at the same moment. There is now one definition, `warningLeadMinutes`, applied
once by `computeSla` and stored as `*_warn_at`; the console, the portal, the API
and the sweep all compare against that instant, and the SQL contains no
percentage arithmetic at all.

Both fixes had to meet the same standard the rest of this build is held to. The
pause writes an event, because a deadline that moved silently would have broken
the replay criterion below — a ticket would appear to have met a target it
looks like it breached, with nothing on the timeline to explain it.

41 unit tests for the arithmetic, including the property that
`businessMinutesBetween` inverts `addBusinessMinutes` across a weekend, and 13
against a real database for the lifecycle: pause, resume, repeated cycles, a
requester's reply restarting the clock, resolution straight out of a pause, and
a breach that a pause cannot undo.

That left the two P1 exit criteria, and both now hold — see the P1 section
above. `replay.integration.test.ts` rebuilds a ticket from its events alone, and
`npm run bench:intake` measures p95 at 67ms against a 2s target.

### Done — the SLA state specification

The audit had left one SLA item open as a product decision: a resume that
appeared to clear an existing breach. Writing every transition down as a table
in [sla.md](sla.md), and pinning each one with a test, showed that it was a
defect. It also turned up two more.

**A stopped clock was read as a running one.** `slaStatus` compared a paused
ticket's deadline, which does not move until the pause ends, with the wall
clock. A deadline that passed while the requester held the ticket read
`breached` and counted in the queue's "past SLA" total, then went back to
`on_track` when the requester replied. A paused clock is now read at the instant
it stopped. A breach that happened before the pause still sticks, and its
lateness is now frozen rather than growing.

**A retriage handed the pause credit back.** The pipeline restamped the
deadlines from `created_at` with nothing carried over. A ticket that had waited
a week had its deadline moved a week earlier, while `sla_paused_minutes` still
said the week had been credited. `computeSla` now takes the credit already
given.

**A retriage could strand a paused ticket.** `applyTriage` wrote the new status
straight onto the row, so a ticket left `awaiting_user` with `sla_paused_at`
still set. In shadow and assist mode nothing followed to close the pause, so the
desk held a ticket whose clock was stopped and which the warning sweep skipped.
The way out of a pause now always goes through `setStatus`.

Three questions were left as decisions rather than defects, each with a
recommendation and a test that pins the current behaviour:

- whether a breach is a recorded fact (D1). Decided on 2026-09-19: it is. See
  "breaches as recorded facts" below.
- whether a human priority change moves the deadlines (D2). Decided on
  2026-09-19: it does. The console restamps from `created_at` with the credit,
  as a retriage does, and logs an `sla_restamp` event (T15). On both paths a
  clock whose result is already recorded keeps it, and a reopen stamps the
  resolution clock for the current priority. The console change and a resume
  now take the same row lock, so neither can overwrite the other.
- whether time spent resolved counts after a reopen (D3). Decided on
  2026-09-19: it does not. `resolved` and `closed` stop the resolution clock,
  and a reopen gives the time back. See "time spent resolved no longer counts"
  below.

### Done — a pause credits only a running clock

The settled rule stopped a priority change from rewriting a recorded result. A
pause could still rewrite one, in two ways, and the specification had listed
both under known limits.

**A pause after a late first response made it on time.** The resume moved both
deadlines, including a first-response clock that had settled before the pause
began. So a reply sent half an hour late, followed by an hour of waiting on the
requester, read `met` once they answered. The resume now moves only the clocks
that are still running, and its event lists the ones it left alone.

**A first response during a pause was credited the whole pause.** Until the
resume it was judged against the stored deadline, and after it against a
deadline carrying the whole wait, including the part after the response. A
clock that was already late when it stopped read `breached` until the requester
replied and `met` afterwards. `markFirstResponse` now settles the clock at the
moment the response is recorded. It takes the same row lock as `setStatus`,
credits the part of the pause before the response, and logs an `sla_pause`
event in the same transaction. A clock that had already breached when it
stopped is credited nothing. Otherwise the credit only preserves how late the
clock was, and in one case it would have recorded `met`: a business-hours
deadline at closing time, paused out of hours, answered during Monday's opening
hours after the console had shown a breach all weekend.

The principle is now stated at the top of [sla.md](sla.md). A running clock's
deadline can move. A recorded outcome cannot, until a reopen starts a new
resolution period. I4 no longer has an exception, and a new invariant, I8,
states the pause half of it.

There are seven new unit tests, including a grid of pause, response and resume
instants on the business clock, and seven new tests against a real database:
both orders of a response racing a resume, and a credit event that fails to
write. The tests that pin the two defects fail with the fix disabled.

### Done — breaches as recorded facts (D1)

A breach used to be only a reading. `slaStatus` compared the deadline the row
had now with the wall clock, and a running clock's deadline can still move. A
downgrade of an open ticket that was already late stamped a later deadline, and
the breach disappeared: from the console, from the portal's "our reply is
overdue", and from anything a report could read. Nothing recorded that it had
happened.

The rule is now at the top of [sla.md](sla.md): **a recorded SLA result is
immutable historical fact. Recalculation may create a new active clock, but it
must not rewrite a previously recorded result.** A breach is a result, just as
an outcome is.

**What is recorded.** `first_response_breached_at` and `resolution_breached_at`
hold the deadline each target first missed. They are set once and never
cleared, not even by a reopen. Each is written in the same transaction as an
`sla_breach` event that says which clock breached, at what priority, whether it
was paused, and which write saw it. A reopen starts a new resolution clock, so
`resolution_clock_breached` says whether the clock running now has breached. The
reopen clears that flag and logs the old clock's result, and the history column
stays.

**Who records it.** All five clock writers now take the row lock, `applyTriage`
included. Each records what its locked row shows before it changes anything,
then what its own change produced. So the downgrade that used to erase a breach
now records it first. A sweep every minute records the clocks that breach on
tickets nobody is touching. It is also the backfill for breaches from before
this release, and it goes through the same `slaStatus` the console reads rather
than a SQL copy of it.

**What changes for a breached clock.** It reads `breached` whatever its deadline
says, so a late answer after a downgrade can no longer read `met`. It keeps the
deadline it missed through a priority change or a retriage, and the restamp
event lists it as settled. A pause still moves a breached clock that has no
outcome yet, by exactly the time it was stopped, so it stays exactly as late as
it was (T8). As a side effect, T8's sub-minute blink is gone: a ticket late only
after closing no longer reads `due_soon` for a minute on Monday morning.

There are eleven new unit tests and thirty new tests against a real database.
They cover the whole matrix for both clocks: a breach is recorded at the
deadline it missed, and a second evaluation or three concurrent ones do not
duplicate it. It is kept through a raise, a downgrade, a pause, a resume and a
retriage. A downgrade, a pause or a retriage that is the first write to see a
breach records it. Nothing is written when the event cannot be. The new tests
also cover both cases of a reopen, the sweep's candidates, two races, and a
replay that rebuilds the three columns from the log alone. Each rule was
disabled in turn, and the tests that pin it failed.

One consequence is left as a decision. Under D3's current behaviour, a reopen
onto a deadline that passed while the ticket was resolved records a breach at
once, and that breach is now permanent. D3 is more pressing than it was.

Not done here: a breach notification, and the compliance report that would read
the columns (SLA-09 and SLA-13 in the [feature audit](feature-audit.md)).

### Done — the retriage under the row lock

`applyTriage` took the row lock for D1 but still wrote a stamp the pipeline had
computed before the model call, from the pause credit it read then. A requester
who replied during the call resumed the clock and was credited the wait, and
the stamp then wrote the uncredited deadline over it. `sla_paused_minutes` said
the wait had been given back and the deadline said it had not.

`applyTriage` now computes the stamp itself, under the lock, from the row it
locked. The order inside its transaction is lock, record any breach the row
shows, stamp from `created_at` for the new priority with the row's credit,
write, record any breach the write produced. The triage result no longer
carries deadlines, so a caller cannot hand it a stamp from an earlier read. The
pipeline passes the settings the decision was made under, so the targets
stamped and `config_version` still come from the same configuration. Every SLA
write now computes from the row it locked. Nothing else about the retriage
changed: a clock whose outcome or breach is recorded keeps its deadline, and a
pause the decision ends still goes through `setStatus`.

There are five new tests against a real database. In the pipeline, a reply
lands during the retriage's model call. This test fails against the previous
code, with the deadline a week early. In `sla-pause`, a retriage waits on a
resume with `raceBehindLock`, and four retriages and resumes run at once in
both orders and must reach the same deadlines. In `sla-breach`, a retriage waits
on a person's upgrade that breached the first response. When the upgrade
recorded the breach, the retriage keeps it and records nothing more. When it
did not, the retriage records it before restamping. In both cases the breached
clock keeps its deadline and the running clock is stamped for the new priority.

D3's reopen behaviour is unchanged, and its tests are untouched.

### Done — time spent resolved no longer counts (D3)

A reopen used to start the new resolution clock on the deadline the old one
had. A requester who reopened three days after an on-time fix landed the desk
an immediate breach for three days in which the ball was with the requester,
and since D1 that breach was permanent.

Decided on 2026-09-19: `resolved` and `closed` stop the resolution clock, as
`awaiting_user` stops both clocks. A reopen credits the time since
`resolved_at`, measured in the units the clock runs in, so the new clock starts
with the margin the old one had when it was resolved. A ticket resolved late is
reopened exactly as late, and records its new clock's breach at once. Closed
counts the same as resolved, because a reply reopens both and the follow-up
sweep closes resolved tickets after a day. The first-response clock is not
affected.

The credit has its own column, `sla_resolved_minutes` (0018), rather than going
into `sla_paused_minutes`, because every restamp adds the pause total to both
clocks. Every restamp (a retriage, a priority change, a reopen) adds the new
column to the resolution window only, so a retriage after a reopen keeps the
credit. The reopen's `sla_clock` event carries the credit, and the replay
rebuilds the column from the log. Nothing recorded under the old rule is
rewritten, and there is no backfill.

The three tests named DOCUMENTS CURRENT BEHAVIOUR became tests of the decided
rule: the credit itself, the margin kept for a ticket resolved in time and one
resolved late, and, against a real database, a late ticket reopening exactly as
late. New alongside them: two unit tests, one for a weekend spent resolved on
the business clock and one showing that a later restamp keeps the credit, and
two tests against a real database, for a reopen three days after an on-time
resolution that records no breach and a replay that rebuilds the credit across
two reopens. [sla.md](sla.md) has the new T13, a new invariant I11, and D3
written up as decided.

### Done — the ticket conversation model

A ticket had an event log and an outbound mail queue and no conversation: no
comments, no internal notes, no stored attachments. Roughly fifty features
downstream assume one. A chat agent needs somewhere to put turns, a copilot
needs a conversation to summarise, and a troubleshooting agent needs to record
which step the user is on.

The model is now built, and [conversation.md](conversation.md) specifies it
with twelve invariants, C1 to C12. It is not a comments table. It is an
append-only log (0019) of messages, drafts and shown activity. Each entry has:

- a gap-free `seq` taken under the conversation's row lock, so no timestamp
  decides the order;
- an author derived from the context: `staff`, `ai`, `system`, or a
  `requester` named only by intake or the portal;
- a `public` or `internal` visibility. Reading internal entries needs the new
  `ticket_internal:read`, which every staff role and the agent hold and the
  portal does not;
- provenance on everything the agent wrote, and `derived_from_id` from a draft
  to the reply it became;
- an idempotency key per tenant;
- attachment metadata in the order attached;
- a `message` event in `ticket_events`, written in the same transaction.

Most rules are enforced twice. `appendMessage` checks who is asking, and the
database checks the rest itself: append-only triggers, author and visibility
shape checks, and composite foreign keys that keep every reference inside one
tenant. Merging a ticket locks its conversation, and the lock wins a race with
a first append.

There are 33 tests against a real database, and each carries the ID of the
invariant it pins. Several write rows directly to prove the database refuses
them without the repository. There are also four unit tests for the derived
state, four new cross-tenant attacks, and two permission tests. Two defects were
found and fixed along the way. A tenant could not be purged once a requester
had written a message, because a plain foreign key refused whichever row
Postgres deleted first. And attachments came back in random order.

Nothing writes to the conversation yet. That was deliberate: the model and its
invariants came first, before any UI or AI behaviour depends on them.

### Done — writing to the conversation

Every writer of a ticket's words now writes to the conversation, and every
reader reads it through `threadFor`. [conversation.md](conversation.md) has the
full table of who writes what, with each writer's key.

- **Intake** writes the requester's opening message and every threaded reply,
  with their attachments. A reply's attachments used to be dropped. A
  redelivered webhook writes nothing and moves the ticket nothing.
- **`ticket.send_reply`** writes the reply linked to its outbound row, under
  the same key. The agent's reply names its model, prompt, configuration and
  sources. A templated reply, such as an incident acknowledgement, is the
  system's and names its template. Who wrote the words is settled before
  anything is queued, so a reply the conversation would refuse is never sent.
- **The pipeline** parks its drafts in the conversation, internal, with the
  same provenance. The model call's cost stays on the audit event.
- **The console** has an internal-note form and a reply form. Sending a draft
  records the draft it came from, and the draft stops being offered.
- **The portal, the API (`?include=messages`) and the knowledge-base
  writeback** read the conversation. The portal and the writeback never see
  internal notes.
- `appendEvent` refuses `reply` and `draft` events, so the event log is an
  audit log again.

**D4, tickets from before the conversation: copied in.** The legacy code was
already in the tree when this block started (0020, `conversation-legacy.ts`,
the backfill and its script), with no tests and no entry in the specification.
It now has both: fifteen unit tests of what each kind of record becomes, and
database tests for the copy, the portal's parity with what it showed before,
repeated and concurrent runs, a dry run, and each refusal. Copies name an
author only when the tenant can vouch for them, carry no provenance the record
did not hold, and are dated by their record (C13).

One gap was closed. The backfill refuses a ticket whose conversation already
holds something newer than an uncopied record (C2). So a reply to an old ticket
before anybody ran the backfill would have stranded that ticket's history for
good. The first write to a conversation now copies the ticket's history before
itself.

Deploy by migrating, deploying, then running `npm run conversations:backfill`,
a dry run first. On the development database the dry run reports 10 tickets,
10 opening messages to copy, and nothing refused. The run itself has not been
done there.

### Done — the golden set, drafted to 100

Everything under "P2 — Intelligent Triage" above is a number
`npm run eval score` already computes and answers `insufficient data` for,
because the set it needs did not exist. `eval/golden-set` now holds 100 cases,
one ticket per file, and `npm run eval golden` lints them clean.

**The guidelines exist now, which they did not.** `golden-case.ts` pointed at
`eval/golden-set/README.md` for the labelling rules and there was no such file;
case rationales cited "G3" and "G4" and nothing defined them. The page is
written: G1 to G14, `label_version` v1 — how priority is judged, what each
safety flag means at its edges, where tenant policy overrides a good runbook,
and the rule that a case is never edited to match what the system did. It also
says what a reviewer is deciding, per case, in six questions.

**46 cases were added, and they were chosen by what the first 54 could not
measure.** The injection rule had no case that could reach it: both existing
injection cases are also destructive and security flagged, and rules 1 and 2
fire first, so a run could not tell a working scanner from one that never
fires. Case-073 reaches it — an instruction sitting in a pasted application
log, where neither flag is true. `clarify_exhausted` was the other gap, of a
subtler kind: two cases spend the tenant's one round and expect the escalation,
but neither names the rule, and `rules` is only scored when a case states it,
so nothing checked the rule that stops a polite agent asking forever. Case-061
names it, and naming it found the thing below. `link_incident` had one case and
now has four. Each of the three scope exclusions in the runbooks — warehouse
scanner accounts, warehouse tablets, VPN on mobile — is now the top-scoring
near miss in a case that must not follow it. And injection has both halves:
true positives, and two probes that must stay unflagged, one of them a
supplier's automated mail whose boilerplate reads "ignore any previous
correspondence" — because a scanner that flags that will escalate a slice of
ordinary supplier traffic for nothing.

Coverage: every category has 9 or more, 28% is held out by hash, and the
scenarios run from `straightforward` to `legacy`. Two thirds of the set expects
`escalate`, and that is the tenant and not a skew — no tool is whitelisted,
every VIP goes to a person, security is never automatic, and there are six
runbooks. A set balanced by hand to look even would be a set of tickets this
tenant does not receive.

**Reviewing one case is now possible without reading JSON.**
`npm run eval golden -- review case-073` prints the case as prose: what
arrived, which turn the behaviour is judged at, what an attachment holds and
that the agent never sees it, every expectation, the protected text, and the
rationale. Before this, naming a case without a decision flag was an error, so
the only way through a hundred cases was the files themselves. The guards are
unchanged and still hold: `--accept` needs a reviewer who is a person by email,
never the case's own author, and the lint runs before anything is written.

**Three things the set found before anybody reviewed it**, from
`npm run eval golden -- run --offline`, which scores the deterministic half —
scrubbing, the injection scan, retrieval, and what the decision branch does
with a correct classification.

1. **`clarify_exhausted` cannot fire.** Intake deliberately does not
   re-enqueue triage when a reply threads onto an existing ticket — "the
   reopen path never routes back to the agent" — so the agent is invoked once
   per ticket, sees `clarify_count` 0, and always takes the asking branch of
   rule 8. The second branch is dead unless `max_clarify_rounds` is 0, which
   means the agent never asks at all. So the tenant's dial has two positions
   today, not four, and `decide.ts` reads as though it had more. Nothing is
   broken; a rule is waiting on a capability that was deliberately not built,
   and now something says so out loud.
2. **The injection scanner misses both new true positives** — an instruction
   inside a pasted application log, and one inside a forwarded phishing mail —
   while still false-alarming on the benign printer ticket that was already in
   the set. Agreement with the label is 97% over 100 cases, and all three
   disagreements are cases written to sit on that line. The outcomes stay
   safe, because both misses escalate for another reason: the safety net
   working, and also why this was invisible until something measured the
   scanner rather than the outcome.
3. **The support floor is being read against the wrong ruler.** No relevant
   runbook clears `kb_support_floor` 0.62 in a dev run, because
   `EMBEDDING_PROVIDER=hash` is a lexical embedder whose scores top out around
   0.35 — it is documented in `embed.ts` as "not semantic, do not ship it".
   The run report now prints the embedder and says so, because
   "relevant runbook clears the support floor: 0%" otherwise reads as a broken
   retriever rather than as an unset threshold. The floor is one of the
   numbers the review is supposed to turn into a measurement.

One more thing found on the way. `packages/eval/test/regression.test.ts` loaded
`eval/baselines/golden/main.json` unguarded, and no such file has ever existed,
so that test had been failing since it was written — the golden regression gate
was red rather than green, which is a quieter failure than it sounds. It now
skips when nothing is pinned, the way the same file already treats the triage
JSONL, and `npm run eval golden` prints whether a baseline exists so the
absence is stated somewhere a person looks.

**Nothing is reviewed.** 0 of 100. That is the correct state and it is also the
whole of what is left.

### Then — the review, and the first baseline

The set is a proposal until somebody reads it, and this is the one block in the
plan that no amount of code finishes. A hundred cases, each one a ticket and
six questions, at a few minutes each.

```
npm run eval golden -- review              what is waiting
npm run eval golden -- review case-001     read it
npm run eval golden -- review case-001 --accept --reviewer you@example.com
npm run eval golden -- review case-001 --changes --note "priority: she has a workaround"
```

Disagreeing is the expected outcome on a good number of them, and several
cases say in their rationale where they expect the system to disagree with the
label — the runbook that is retrieved correctly and still says a person must
act, the two flags that fire in a different order than you would guess. Those
are findings about the system, and editing the case to match what it does is
the one move that turns an evaluation into a mirror.

Then pin a baseline — `npm run eval golden -- run --save-baseline main` — and
every line under "P2 — Intelligent Triage" starts returning a number instead of
`insufficient data`. That is what turns the confidence threshold in
`businesses.settings` from a guess into a measurement, and every autonomy
decision after it — which categories run unattended, at what confidence — is an
argument from those numbers or it is taste.

### Not yet — the advanced section

Correctly placed at the end. The temptation to start it early is the thing that
kills these projects.

## The invariant

**The agent can never make itself more autonomous.**

Confidence thresholds, unattended categories, action permissions, approval
requirements and routing rules are configuration, and configuration changes go
through authenticated human authorization plus a configuration audit log. No
tool writes settings, no model output widens a whitelist, and `effectiveMode`
can only narrow.

All three halves now hold. The code-level half was always there. The
authorization half is `agentContext`, whose permission set excludes
`config:update`, `security:update`, `agent:configure` and `action:approve` — so
the pipeline cannot widen its own autonomy or sign off its own actions, and that
is enforced by the type it runs under rather than by convention. The logging
half is `audit_events`. `packages/core/test/authorization.test.ts` asserts the
agent's permission set directly, so a future grant that quietly adds
`config:update` to it fails the build.

The REST API does not open a fourth door. A key carries a role and gets exactly
that role's permissions from the same grant table, so reaching autonomy through
one would mean holding `security:update` — and a key with that is a credential
an administrator deliberately minted, audited at creation, revocable in a
column, and incapable of outranking the person who minted it.

## Phase gates

A phase is not complete when its features exist. It is complete when it can
prove the line below.

| Phase | Must prove before moving on |
|---|---|
| P1 | Tenant isolation + RBAC + authenticated audit actors + health checks + a REST API, plus event-log replay and p95 intake under 2s at 10× volume — **met**, every line demonstrated by a test or a benchmark |
| P2 | Calibrated triage + measurable threshold performance |
| P3 | RAG groundedness ≥ 95% + safe handling of untrusted ticket content |
| P4 | False resolve < 2%, stable or falling + kill-switch drill |
| P5 | Zero unattended destructive actions + approval expiry + post-action verification |
| P6 | Enterprise integrations + reliability/DR + proactive capabilities |

The detailed exit criteria for each are at the top of this document.
