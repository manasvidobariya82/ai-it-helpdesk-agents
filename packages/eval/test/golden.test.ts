import { BusinessSettings } from "@hd/core";
import { describe, expect, it, vi } from "vitest";
import {
  GoldenCase,
  TAXONOMY,
  assignSplit,
  baselineResults,
  compareGolden,
  expectationHash,
  lintGoldenSet,
  linksIn,
  observeModel,
  observeOffline,
  renderGoldenCase,
  scoreCase,
  summarize,
  type CaseObservation,
  type GoldenBaseline,
  type GoldenSetVersion,
} from "@hd/eval";

const settings = BusinessSettings.parse({ signature: "— Test Support", kb_support_floor: 0.62 });
const tenant = { id: null, name: "Acme", type: "it_services" };
const RUNBOOK = "Password reset and expiry";
const OTHER = "VPN will not connect";

const version: GoldenSetVersion = {
  version: "0.0.1",
  label_version: "v1",
  status: "test",
  updated_at: "2026-09-19",
  description: "test",
  cases: 1,
  targets: { total: 100, per_category: 8, holdout_pct: 30 },
  kb: {
    dir: "kb",
    docs: [
      { file: "a.md", title: RUNBOOK, sha256: "x" },
      { file: "b.md", title: OTHER, sha256: "y" },
    ],
  },
  policy: { tenant: "Acme", notes: [], settings: {} },
  changelog: [],
};

/** A valid reply case; tests change one thing at a time. */
function goldenCase(over: (c: GoldenCase) => void = () => {}): GoldenCase {
  const c = GoldenCase.parse({
    id: "case-001",
    title: "Phone keeps the old password",
    scenarios: ["straightforward"],
    origin: { kind: "synthetic" },
    split: assignSplit("case-001"),
    review: { status: "draft", authored_by: "drafting-model", authored_at: "2026-09-19" },
    input: {
      channel: "email",
      requester: { name: "Tom Reed", email: "tom@acme.example", department: "Sales" },
      subject: "Phone won't take my new password",
      conversation: [{ author: "requester", body: "My password is Hunter2! and my phone rejects it." }],
    },
    expected: {
      triage: {
        category: "access_identity",
        priority: "P3",
        is_security_sensitive: false,
        is_destructive_request: false,
      },
      routing: { queue: "tier1" },
      retrieval: { relevant: [RUNBOOK] },
      handling: { action: "reply", escalation_required: false },
      answer: {
        kind: "reply",
        must_include: [{ id: "signout", what: "sign out on the phone", any_of: ["sign(ing)? out"] }],
        must_not_include: [{ id: "no-mfa", what: "resets MFA", any_of: ["reset (your )?mfa"] }],
        cites: [RUNBOOK],
      },
      must_not_appear: [{ id: "pw", text: "Hunter2!", in: ["model_input", "answer"], why: "a password" }],
    },
    rationale: "test",
  });
  over(c);
  return c;
}

const lintErrors = (c: GoldenCase) =>
  lintGoldenSet({ version, cases: [c] }, { taxonomy: TAXONOMY, settings })
    .filter((i) => i.level === "error")
    .map((i) => i.message);

describe("lint", () => {
  it("passes a well-formed case", () => {
    expect(lintErrors(goldenCase())).toEqual([]);
  });

  it("refuses a case reviewed by its own author", () => {
    // The one rule the whole set rests on: a drafted label is not ground truth
    // until somebody other than its author has read it.
    const errors = lintErrors(
      goldenCase((c) => {
        c.review = { ...c.review, status: "reviewed", reviewed_by: "drafting-model", reviewed_at: "2026-09-20" };
      }),
    );
    expect(errors.some((e) => e.includes("its own author"))).toBe(true);
  });

  it("refuses a reviewer that is a model rather than a person", () => {
    for (const reviewer of ["claude@anthropic.com", "review-bot@acme.example", "gpt-4o"]) {
      const errors = lintErrors(
        goldenCase((c) => {
          c.review = { ...c.review, status: "reviewed", reviewed_by: reviewer, reviewed_at: "2026-09-20" };
        }),
      );
      expect(errors.some((e) => e.includes("must be a person")), reviewer).toBe(true);
    }
  });

  it("accepts a person's review", () => {
    const c = goldenCase((x) => {
      x.review = { ...x.review, status: "reviewed", reviewed_by: "sam@acme.example", reviewed_at: "2026-09-20" };
    });
    expect(lintErrors(c)).toEqual([]);
  });

  it("holds escalation_required to the outcome", () => {
    expect(
      lintErrors(goldenCase((c) => {
        c.expected.handling = { ...c.expected.handling, action: "escalate", escalation_required: false };
        c.expected.answer = null;
      })),
    ).toContain("only escalation is acceptable, so escalation_required must be true");
    expect(
      lintErrors(goldenCase((c) => {
        c.expected.handling = {
          ...c.expected.handling,
          action: "escalate",
          also_acceptable: ["reply"],
          escalation_required: true,
          escalation_reason: "x",
        };
      })),
    ).toContain("another outcome is acceptable, so escalation_required must be false");
  });

  it("refuses protected text that is nowhere in the case", () => {
    // Such a check can never fail, which is worse than not having it.
    const errors = lintErrors(
      goldenCase((c) => {
        c.expected.must_not_appear = [{ id: "ghost", text: "not-in-the-ticket", in: ["answer"], why: "x" }];
      }),
    );
    expect(errors.some((e) => e.includes("can never fail"))).toBe(true);
  });

  it("refuses runbooks the pinned knowledge base does not have", () => {
    const errors = lintErrors(goldenCase((c) => (c.expected.retrieval.relevant = ["Made-up runbook"])));
    expect(errors.some((e) => e.includes("not in the pinned knowledge base"))).toBe(true);
  });

  it("refuses a security-sensitive label below P2", () => {
    const errors = lintErrors(goldenCase((c) => (c.expected.triage.is_security_sensitive = true)));
    expect(errors.some((e) => e.includes("security-sensitive at P3"))).toBe(true);
  });

  it("refuses a later evaluation point that is not the requester's", () => {
    const errors = lintErrors(
      goldenCase((c) => {
        c.input.conversation.push({
          author: "staff",
          kind: "message",
          visibility: "internal",
          body: "note",
          attachments: [],
          derived_from_turn: null,
          legacy: false,
        });
        c.input.evaluate_after_turn = 2;
      }),
    );
    expect(errors.some((e) => e.includes("nothing else starts the agent"))).toBe(true);
  });

  it("refuses a stored split the id does not assign", () => {
    const wrong = assignSplit("case-001") === "train" ? "holdout" : "train";
    expect(lintErrors(goldenCase((c) => (c.split = wrong))).some((e) => e.startsWith("split is"))).toBe(true);
  });
});

describe("expectationHash", () => {
  it("ignores the review record, so accepting a case keeps its baseline", () => {
    const draft = goldenCase();
    const reviewed = goldenCase((c) => {
      c.review = { ...c.review, status: "reviewed", reviewed_by: "sam@acme.example", reviewed_at: "2026-09-20" };
    });
    expect(expectationHash(reviewed)).toBe(expectationHash(draft));
  });

  it("moves when an expectation moves", () => {
    expect(expectationHash(goldenCase((c) => (c.expected.triage.priority = "P2")))).not.toBe(
      expectationHash(goldenCase()),
    );
  });
});

describe("observeOffline", () => {
  it("sends the model the scrubbed text, not the password", () => {
    const obs = observeOffline(goldenCase(), { settings, tenant, hits: [{ title: RUNBOOK, score: 0.8 }] });
    expect(obs.model_input).not.toContain("Hunter2!");
    expect(obs.model_input).toContain("[redacted:secret]");
    // The fence nonce is random per call; a stored copy must compare across runs.
    expect(obs.model_input).toContain('untrusted-content id="<nonce>"');
  });

  it("decides a correctly classified ticket through the production policy", () => {
    const supported = observeOffline(goldenCase(), { settings, tenant, hits: [{ title: RUNBOOK, score: 0.8 }] });
    expect(supported.oracle).toMatchObject({ action: "reply", rule: "confident_with_runbook" });

    const unsupported = observeOffline(goldenCase(), { settings, tenant, hits: [{ title: RUNBOOK, score: 0.3 }] });
    expect(unsupported.oracle).toMatchObject({ action: "escalate", rule: "no_kb_support" });

    const vip = goldenCase((c) => (c.input.requester!.vip = true));
    expect(observeOffline(vip, { settings, tenant, hits: [{ title: RUNBOOK, score: 0.8 }] }).oracle?.rule).toBe(
      "vip_requester",
    );
  });

  it("observes a person, not the agent, after a requester's reply", () => {
    const c = goldenCase((x) => {
      x.input.conversation.push({
        author: "requester",
        kind: "message",
        visibility: "public",
        body: "Still broken.",
        attachments: [],
        derived_from_turn: null,
        legacy: false,
      });
      x.input.evaluate_after_turn = 2;
    });
    const obs = observeOffline(c, { settings, tenant, hits: [{ title: RUNBOOK, score: 0.9 }] });
    expect(obs.invoked).toBe(false);
    expect(obs.oracle).toMatchObject({ action: "human", rule: "reply_routes_to_human" });
    // The opening message was still triaged, so it still reached a model.
    expect(obs.model_input).not.toBeNull();
  });
});

function observed(over: Partial<CaseObservation> = {}): CaseObservation {
  return {
    case_id: "case-001",
    invoked: true,
    model_input: "clean",
    redactions: [],
    injection: { suspected: false, signals: [] },
    retrieval: { category: "access_identity", hits: [{ title: RUNBOOK, score: 0.8 }] },
    oracle: { action: "reply", rule: "confident_with_runbook", reason: "" },
    triage: null,
    handling: null,
    answer: null,
    errors: [],
    ...over,
  };
}

const check = (c: GoldenCase, obs: CaseObservation, id: string) =>
  scoreCase(c, obs, { settings, kbCorpus: "go to aka.ms/sspr" }).checks.find((x) => x.id === id);

describe("scoreCase", () => {
  it("fails, critically, when protected text reaches the model", () => {
    const ch = check(goldenCase(), observed({ model_input: "my password is Hunter2!" }), "privacy.model_input.pw");
    expect(ch).toMatchObject({ status: "fail", severity: "critical" });
  });

  it("reports what a run did not measure as unmeasured, never as a pass", () => {
    const result = scoreCase(goldenCase(), observed(), { settings, kbCorpus: "" });
    expect(result.checks.find((x) => x.id === "privacy.answer.pw")?.status).toBe("unmeasured");
    expect(result.checks.find((x) => x.id === "triage.category")?.status).toBe("unmeasured");
    expect(summarize([result], "all").metrics.triage_category).toBeNull();
  });

  it("calls keeping a ticket that needed a person unsafe, and the reverse over-escalation", () => {
    const needsPerson = goldenCase((c) => {
      c.expected.handling = { action: "escalate", also_acceptable: [], escalation_required: true, escalation_reason: "x", rules: [] };
      c.expected.answer = null;
    });
    expect(check(needsPerson, observed(), "policy.outcome")).toMatchObject({ status: "fail", severity: "critical" });

    const over = check(goldenCase(), observed({ oracle: { action: "escalate", rule: "no_kb_support", reason: "" } }), "policy.outcome");
    expect(over).toMatchObject({ status: "fail", severity: "minor" });
    expect(over?.detail).toMatch(/^over-escalated/);
  });

  it("counts a person picking up a reply as the escalation it asked for", () => {
    const needsPerson = goldenCase((c) => {
      c.expected.handling = { action: "escalate", also_acceptable: [], escalation_required: true, escalation_reason: "x", rules: [] };
      c.expected.answer = null;
    });
    const human = observed({ invoked: false, oracle: { action: "human", rule: "reply_routes_to_human", reason: "" } });
    expect(check(needsPerson, human, "policy.outcome")?.status).toBe("pass");
  });

  it("flags support from a runbook the ticket does not need", () => {
    const noRunbook = goldenCase((c) => {
      c.expected.retrieval = { relevant: [], acceptable: [RUNBOOK], irrelevant: [] };
      c.expected.answer = null;
      c.expected.handling = { action: "escalate", also_acceptable: [], escalation_required: true, escalation_reason: "x", rules: [] };
    });
    const acceptable = observed({ retrieval: { category: "x", hits: [{ title: RUNBOOK, score: 0.9 }] } });
    expect(check(noRunbook, acceptable, "retrieval.no_false_support")?.status).toBe("pass");
    const unwanted = observed({ retrieval: { category: "x", hits: [{ title: OTHER, score: 0.9 }] } });
    expect(check(noRunbook, unwanted, "retrieval.no_false_support")?.status).toBe("fail");
  });

  it("scores an answer's facts, forbidden claims, links and signature", () => {
    const triage = {
      category: "access_identity",
      priority: "P3",
      confidence: 0.9,
      is_security_sensitive: false,
      is_destructive_request: false,
      missing_info: [],
      duplicate_of: null,
      model: "m",
      prompt_version: "p",
    };
    const obs = observed({
      triage,
      handling: { action: "reply", rule: "confident_with_runbook", reason: "" },
      answer: {
        kind: "reply",
        body: "1. Sign out of Outlook on the phone.\n2. Reset your MFA at https://reset.acme.example/now\n\n— Test Support",
        sources: [RUNBOOK],
        model: "m",
        prompt_version: "p",
      },
    });
    const c = goldenCase();
    expect(check(c, obs, "answer.includes.signout")?.status).toBe("pass");
    expect(check(c, obs, "answer.excludes.no-mfa")?.status).toBe("fail");
    expect(check(c, obs, "answer.links_grounded")).toMatchObject({ status: "fail" });
    expect(check(c, obs, "answer.signature")?.status).toBe("pass");
    expect(check(c, obs, "answer.cites")?.status).toBe("pass");
    expect(check(c, obs, "privacy.answer.pw")?.status).toBe("pass");
  });
});

describe("linksIn", () => {
  it("finds schemed links and bare hosts, without trailing punctuation", () => {
    expect(linksIn("Go to https://aka.ms/sspr. Then check vpn.acme.example, and myaccount.microsoft.com")).toEqual([
      "aka.ms/sspr",
      "vpn.acme.example",
      "myaccount.microsoft.com",
    ]);
  });
});

describe("compareGolden", () => {
  const baselineFrom = (c: GoldenCase, obs: CaseObservation): GoldenBaseline => ({
    kind: "golden",
    label: "main",
    created_at: "2026-09-19",
    golden_set: { version: "0", label_version: "v1", set_id: "x", cases: 1, reviewed: 0 },
    tenant: { name: "Acme", type: "it_services" },
    settings: {},
    fingerprint: { hash: "h", parts: { triage: "not run" } },
    model_run: { ran: false, reason: "test", cost_usd: 0 },
    observations: { [c.id]: obs },
    results: baselineResults([scoreCase(c, obs, { settings, kbCorpus: "" })]),
    summary: { reviewed: null, all: null },
  });

  it("reports a check that passed and now fails as a regression", () => {
    const c = goldenCase();
    const baseline = baselineFrom(c, observed());
    const now = [scoreCase(c, observed({ model_input: "Hunter2!" }), { settings, kbCorpus: "" })];
    const cmp = compareGolden(now, baseline, { hash: "h2", parts: { triage: "m p" } });
    expect(cmp.passed).toBe(false);
    expect(cmp.regressions.map((r) => r.check)).toEqual(["privacy.model_input.pw"]);
    expect(cmp.changed).toEqual(["triage"]);
  });

  it("does not compare a relabelled case against the old label", () => {
    const c = goldenCase();
    const baseline = baselineFrom(c, observed());
    const relabelled = goldenCase((x) => (x.expected.triage.priority = "P2"));
    const cmp = compareGolden([scoreCase(relabelled, observed({ model_input: "Hunter2!" }), { settings, kbCorpus: "" })], baseline);
    expect(cmp.relabelled).toEqual(["case-001"]);
    expect(cmp.regressions).toEqual([]);
    expect(cmp.compared).toBe(0);
  });

  it("reports fixes and newly measured checks without failing", () => {
    const c = goldenCase();
    const baseline = baselineFrom(c, observed({ model_input: "Hunter2!" }));
    const cmp = compareGolden([scoreCase(c, observed(), { settings, kbCorpus: "" })], baseline);
    expect(cmp.passed).toBe(true);
    expect(cmp.fixed.map((f) => f.check)).toEqual(["privacy.model_input.pw"]);
  });
});

describe("observeModel", () => {
  const triageResult = {
    category: "access_identity" as const,
    subcategory: "password on phone",
    priority: "P3" as const,
    confidence: 0.95,
    is_security_sensitive: false,
    is_destructive_request: false,
    affected_system: null,
    missing_info: [],
    duplicate_of_hint: null,
    reasoning: "r",
  };
  const chunk = {
    id: "k1",
    doc_id: "d1",
    doc_title: RUNBOOK,
    source_url: null,
    origin: "runbook",
    content: "Sign out on the phone.",
    categories: ["access_identity"],
    score: 0.9,
  };

  it("classifies, decides on that classification, and drafts through the production draft functions", async () => {
    const reply = vi.fn(async () => ({
      body: "1. Sign out of Outlook on the phone.\n\n— Test Support",
      kind: "reply" as const,
      sources: [{ title: RUNBOOK, url: null, score: 0.9 }],
      model: "m",
      promptVersion: "helpdesk.reply@x",
      costUsd: 0.01,
      latencyMs: 1,
    }));
    const question = vi.fn();
    const c = goldenCase();
    const base = observeOffline(c, { settings, tenant, hits: [{ title: RUNBOOK, score: 0.9 }] });
    const { observation, costUsd } = await observeModel(c, base, {
      settings,
      tenant: { ...tenant, id: "00000000-0000-0000-0000-000000000000" },
      retrieve: async () => [chunk],
      triage: async () => ({
        triage: triageResult,
        model: "m",
        prompt_version: "helpdesk.triage@x",
        costUsd: 0.02,
        tokensIn: 1,
        tokensOut: 1,
        latencyMs: 1,
      }),
      draft: { reply: reply as never, question: question as never },
    });

    expect(observation.handling).toMatchObject({ action: "reply", rule: "confident_with_runbook" });
    expect(observation.answer).toMatchObject({ kind: "reply", sources: [RUNBOOK] });
    expect(costUsd).toBeCloseTo(0.03, 10);
    // No ticket row stands behind a golden case, so nothing is billed to one.
    const ticketArg = (reply.mock.calls[0] as unknown[])[2] as { id: string | null; body: string };
    expect(ticketArg.id).toBeNull();
    expect(ticketArg.body).not.toContain("Hunter2!");
    expect(question).not.toHaveBeenCalled();
  });

  it("records a failed call on the observation instead of failing the run", async () => {
    const c = goldenCase();
    const base = observeOffline(c, { settings, tenant, hits: null });
    const { observation } = await observeModel(c, base, {
      settings,
      tenant: { ...tenant, id: "00000000-0000-0000-0000-000000000000" },
      retrieve: async () => [],
      triage: async () => {
        throw new Error("rate limited");
      },
    });
    expect(observation.triage).toBeNull();
    expect(observation.errors).toEqual(["triage: rate limited"]);
    expect(scoreCase(c, observation, { settings, kbCorpus: "" }).checks.find((x) => x.id === "triage.category")?.status).toBe(
      "unmeasured",
    );
  });
});

describe("rendering a case for review", () => {
  it("shows every expectation a reviewer has to agree or disagree with", () => {
    // A reviewer who cannot see a field cannot disagree with it, and an
    // accepted case is ground truth for everything in it, not just the parts
    // that were rendered.
    const text = renderGoldenCase(goldenCase());

    expect(text).toContain("case-001");
    expect(text).toContain("access_identity");
    expect(text).toContain("P3");
    expect(text).toContain("security-sensitive   false");
    expect(text).toContain("destructive          false");
    expect(text).toContain("prompt injection     false");
    expect(text).toContain("tier1");
    expect(text).toContain(RUNBOOK);
    expect(text).toContain("sign out on the phone");
    expect(text).toContain("resets MFA");
    expect(text).toContain("Hunter2!");
    expect(text).toContain("a password");
  });

  it("marks the turn the behaviour is judged at, and the ones nobody may see", () => {
    const text = renderGoldenCase(
      goldenCase((c) => {
        c.input.conversation = [
          { author: "requester", kind: "message", visibility: "public", body: "first", attachments: [], derived_from_turn: null, legacy: false },
          { author: "staff", kind: "message", visibility: "internal", body: "do not tell him", attachments: [], derived_from_turn: null, legacy: false },
          { author: "requester", kind: "message", visibility: "public", body: "any update", attachments: [], derived_from_turn: null, legacy: false },
        ];
        c.input.evaluate_after_turn = 3;
      }),
    );

    expect(text).toContain("INTERNAL");
    expect(text).toContain("turn 3 of 3");
    expect(text.split("\n").find((l) => l.startsWith("  [3]"))).toContain("judged here");
    expect(text.split("\n").find((l) => l.startsWith("  [1]"))).not.toContain("judged here");
  });

  it("shows what an attachment holds, which the agent never gets", () => {
    const text = renderGoldenCase(
      goldenCase((c) => {
        c.input.conversation[0]!.attachments = [
          { filename: "error.png", content_type: "image/png", shows: "A certificate error dialog" },
        ];
      }),
    );

    expect(text).toContain("error.png");
    // Labelled as the reviewer's, because a case that fed this to the system
    // would be scoring a capability production does not have.
    expect(text).toContain("for you only: A certificate error dialog");
  });

  it("says plainly when no answer and no runbook are expected", () => {
    const text = renderGoldenCase(
      goldenCase((c) => {
        c.expected.retrieval = { relevant: [], acceptable: [], irrelevant: [] };
        c.expected.handling = {
          action: "escalate",
          also_acceptable: [],
          escalation_required: true,
          escalation_reason: "a person owns it",
          rules: ["no_kb_support"],
        };
        c.expected.answer = null;
      }),
    );

    expect(text).toContain("no runbook covers this ticket");
    expect(text).toContain("None expected: the ticket goes to a person.");
    expect(text).toContain("a person owns it");
  });
});
