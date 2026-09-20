# IT helpdesk agent — the design this was built from

The original brief, and where the implementation diverged from it.

---

## The agent workflow

**1. Intake.** Tickets arrive from email, a web widget, Slack/Teams, or a phone
transcript. Normalize everything into one ticket object:
`{source, requester, subject, body, attachments, timestamp, device/asset info}`.

**2. Triage.** One structured LLM call returns JSON: category
(password/access, hardware, software, network, email, security,
request-for-new-thing), priority P1–P4 (P1 = outage or security incident),
affected asset/system, confidence score, missing-info flags.

**3. Enrich.** Look up the requester in the directory (department, role, device,
past tickets), pull asset status, check for an ongoing incident. This is what
makes the agent feel competent instead of generic.

**4. Retrieve.** Semantic search over runbooks, past resolved tickets, vendor
docs and internal policies. Return the top 3–5 chunks with sources.

**5. Decide.**

| Path | When | Action |
|---|---|---|
| Auto-resolve | High confidence + a known runbook | Reply with steps, or execute the fix |
| Auto-action | Safe, reversible, whitelisted | Password reset, licence grant, group add, VPN reissue |
| Clarify | Missing info | Ask one targeted question, wait |
| Escalate | Low confidence, P1, security, or anything destructive | Route to a human with a full summary + suggested fix |

Hard rule: never let the agent do anything irreversible (delete accounts, wipe
devices, change firewall rules) without human approval. Whitelist actions
explicitly rather than blacklisting.

**6. Execute.** Actions go through a tool layer — Google Workspace / Entra ID /
Okta, Jira or Freshservice, MDM. Every call logged with the ticket id.

**7. Follow up and close.** Auto-check back after 24h. If resolved, close and
write the resolution back into the knowledge base as a new embedded document.
That feedback loop is what makes month three much better than month one.

---

## Build plan

- **Phase 1 — Foundation (week 1–2).** Ticket data model, intake from one
  channel only (email is easiest), Next.js dashboard listing tickets. No AI yet.
  Get the plumbing right.
- **Phase 2 — Triage (week 3).** Add the classification call. Show the AI's
  category/priority/confidence in the dashboard but let humans still handle
  everything. Measure classification accuracy against what your humans pick.
- **Phase 3 — Knowledge base + RAG (week 4–5).** Ingest runbooks and historical
  tickets, chunk, embed, store in pgvector. Add "suggested reply" to the
  dashboard — a human clicks send. Still zero autonomy.
- **Phase 4 — Auto-resolve, narrow (week 6–7).** Pick the two highest-volume,
  lowest-risk categories (password resets and "how do I…" questions are usually
  30–40% of volume). Let the agent send those replies unattended above a
  confidence threshold. Keep a human review queue.
- **Phase 5 — Actions (week 8–10).** Wire in the identity provider and ticketing
  tool. Start with read-only calls, then one write action. Add an approval step
  in the UI for anything above the safe tier.
- **Phase 6 — Multichannel + learning (week 11+).** Add Slack/Teams, then the
  resolution-writeback loop, then analytics: deflection rate, mean time to
  resolve, escalation rate, CSAT.

The main thing that kills these projects is starting with autonomy. Phases 2
and 3 feel like slow progress because the agent is not doing anything yet, but
they are what earn you the data to know which categories are safe to automate.

## Stack

Next.js + TypeScript for the dashboard and API routes. Postgres + pgvector, one
database instead of two, fine well past 100k tickets. A queue (BullMQ or
Inngest) because LLM calls are slow and tickets arrive in bursts. Claude for
triage and drafting, a cheap embedding model for retrieval. Structured outputs
with a Zod schema on every LLM call, so bad JSON fails loudly instead of
silently.

## Metrics

Deflection rate (tickets closed with no human touch), escalation accuracy (did
it escalate the right ones), first-response time, and the false-resolve rate —
tickets the agent closed that the user reopened. That last one is the one to
watch; it is the failure mode that erodes trust fastest.

## Calibrating the confidence threshold

Do not pick a number because it looks reasonable. Run phase 2 in shadow mode for
two weeks, log `(confidence, agent_category, human_category)` for every ticket,
then plot accuracy by confidence bucket. Set the threshold where accuracy
crosses ~95%. It is usually higher than people expect on first run, and it
differs per category — access requests calibrate well, "software" is a mess.

## Shared infrastructure with the business ops agent

The two agents are the same machine pointed at different inboxes.

| Layer | What it does |
|---|---|
| `businesses` + settings | Multi-tenant scoping. Every query filters on `business_id`, from day one; retrofitting tenancy is miserable. |
| Intake normalizer | Email/Slack/webhook → one canonical message object. Idempotency by `source_message_id`. |
| Identity resolution | Email → person → department, role, history. Ops calls them "leads", helpdesk calls them "requesters". |
| LLM gateway | One wrapper: schema validation, retries, token accounting, per-tenant cost caps. Also where you swap models without touching feature code. |
| RAG store | `kb_chunks`, chunker, embedder, retriever, partitioned by `business_id` and `origin`. |
| Job queue | Every model call and tool call is a job. Retries with backoff, dead-letter queue you actually look at. |
| Tool/action layer | Typed wrappers over Google Workspace, Entra, Slack, Jira, CRM. One registry, permissions declared per tool per agent. |
| Approval workflow | Human-in-the-loop gate. Same UI component, different action lists. |
| Event log + analytics | `ticket_events` generalizes to `entity_events`. One dashboard, filtered by agent. |

Deliberately **not** shared: triage taxonomies, SLA logic, tone, and autonomy
thresholds.

Build the helpdesk agent second, but extract the shared packages *while*
building the first one, not after.

---

## As built: where this diverged

Everything above is implemented as described, with these differences.

**A fifth risk tier, `internal`.** The brief has safe/whitelisted versus
everything-else. In practice `ticket.escalate` had to be `safe_write`, which
meant a tenant with an empty whitelist could not escalate — the gate turned a
cautious agent into a stuck one. `internal` covers writes to our own ticket
record that contact nobody, and is never gated.

**Bounds are validated after parsing, not in the wire schema.** The brief puts
`.max(60)` and `.min(0).max(1)` on the Zod schema sent to the model. Constrained
decoding is reliable for shapes and enums, less so for numeric and length
bounds, and a bound the model cannot see is a bound it cannot correct. The wire
schema carries types, enums and descriptions; `validateTriage` enforces the
bounds afterwards and throws, which drives the gateway's one retry with the
error text attached.

**Two autonomy gates rather than one threshold.** A global `AGENT_MODE` for how
far along the phase plan the deployment is, and a per-category autonomy level
for which categories have earned it. The brief implies the second; the first is
what makes "run phase 2 for two weeks" a config change rather than a branch.

**The queue lives in `packages/core`.** The brief's repo shape has no queue
package. Both the dashboard and the worker enqueue, so it sits in core next to
the other shared plumbing rather than becoming a seventh package.

**A `kb_documents` table.** `kb_chunks.doc_id` in the brief has no parent table.
Added one, so re-ingesting an unchanged file is a hash lookup instead of a
re-embed.

**Two extra tables for the phase plan.** `triage_shadow` holds the
agent-versus-human counterfactual that phase 2 exists to collect, and
`llm_usage` holds model spend including calls with no ticket (embedding,
backfills) so the per-tenant cost cap has something to read.

**Confidence thresholds are per category in the database.** The brief says the
threshold differs per category; this stores it that way rather than as one
constant, and defaults every unknown category to closed.

**Three more escalation rules than the brief's four paths.** The brief's decide
step has auto-resolve, auto-action, clarify and escalate. Pointing this at a
real inbox added `injection_suspected` (the text tried to steer the agent, so
the classification drawn from it is suspect too), `vip_requester` and
`department_policy`. The last two are tenant routing rather than judgements
about the ticket, which is why they are settings and not code.

**Threading, and a merge that keeps the source.** The brief deduplicates on
`source_message_id`, which catches a webhook retry and nothing else. A reply is
not a retry: without `Message-ID`/`In-Reply-To`/`References` threading, "thanks,
that worked" opens a second ticket and gets answered with a runbook. Duplicates
that are not replies are *proposed* to a human, never merged automatically, and
merging closes the source with a pointer instead of deleting it.

**Two SLA clocks rather than one.** Calendar time for P1, because a 2am outage
does not wait until nine; business hours for everything else, because a P4
raised at 4:55pm on Friday should not breach over the weekend. All the
arithmetic happens in the tenant's wall clock so a due date on the far side of
a DST change is still the time people expect.

**Redaction is split by direction.** Secrets are scrubbed at rest at intake;
PII is redacted in transit, before a model call and before embedding. The brief
treats redaction as one switch. It cannot be: scrubbing names and emails out of
the database would break the product, and leaving a pasted password in it is a
liability from the moment the row is written.

**Rate limits as well as cost caps.** The brief has a per-tenant spend ceiling.
That is the wrong instrument for a mail loop — by the time a bounce storm shows
up in the spend graph it has already been running for hours. Per-requester and
per-tenant hourly run counts sit in their own table, because a run that never
reached the model still counts.

**A `staff` table.** `tickets.assigned_to` is in the brief's model with nothing
to point at. Escalation routes to a queue name (`tier1`, `oncall`), so the
queues have to exist somewhere, and the console needs a list to assign from.

**A requester portal instead of Slack/Teams.** The brief's phase 6 is chat
adapters. What got built is the web widget from the brief's intake list, plus
the status page that makes it useful: same intake door, so dedupe, identity
resolution, scrubbing and the audit trail are identical. The link is an HMAC
capability URL rather than a login, because asking someone locked out of their
account to log in to find out why is the oldest joke in IT support.

