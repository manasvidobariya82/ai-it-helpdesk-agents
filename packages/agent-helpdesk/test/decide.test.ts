import { describe, expect, it } from "vitest";
import { BusinessSettings, type AgentMode } from "@hd/core";
import { decide, type DecisionInput } from "../src/decide.js";
import type { TriageResult } from "../src/schema.js";

/**
 * These tests are the safety argument for the whole system. Every rule that
 * can stop the agent gets a case, and the "no autonomy can override this"
 * rules get a case per mode.
 */

const baseTriage: TriageResult = {
  category: "access_identity",
  subcategory: "password expiry",
  priority: "P3",
  confidence: 0.99,
  is_security_sensitive: false,
  is_destructive_request: false,
  affected_system: "Entra ID",
  missing_info: [],
  duplicate_of_hint: null,
  reasoning: "Straightforward expired password with a documented self-service path.",
};

const openSettings = BusinessSettings.parse({
  default_policy: { autonomy: "act", confidence_threshold: 0.8 },
  kb_support_floor: 0.6,
  auto_action_whitelist: ["identity.reset_password", "identity.unlock_account"],
  max_clarify_rounds: 1,
  // Off by default here so the older cases test the rule they are named for;
  // the routing rules get their own describe block.
  vip_always_human: false,
});

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    mode: "auto",
    settings: openSettings,
    triage: baseTriage,
    kbTopScore: 0.85,
    clarifyCount: 0,
    matchedIncidentId: null,
    requesterVip: false,
    requesterDepartment: null,
    injectionSuspected: false,
    candidateAction: null,
    ...overrides,
  };
}

const ALL_MODES: AgentMode[] = ["shadow", "assist", "auto"];

describe("hard stops", () => {
  it.each(ALL_MODES)(
    "escalates a destructive request in %s mode, whatever the confidence",
    (mode) => {
      const d = decide(
        input({
          mode,
          triage: { ...baseTriage, is_destructive_request: true, confidence: 1 },
        }),
      );
      expect(d.rule).toBe("destructive_request");
      expect(d.intendedPath).toBe("escalated");
      expect(d.path).toBe("escalated");
    },
  );

  it.each(ALL_MODES)("escalates security-sensitive tickets in %s mode", (mode) => {
    const d = decide(
      input({
        mode,
        triage: {
          ...baseTriage,
          is_security_sensitive: true,
          priority: "P2",
          confidence: 1,
        },
      }),
    );
    expect(d.rule).toBe("security_sensitive");
    expect(d.path).toBe("escalated");
  });

  it("escalates the security_incident category even when the flag is unset", () => {
    const d = decide(
      input({ triage: { ...baseTriage, category: "security_incident", confidence: 1 } }),
    );
    expect(d.rule).toBe("security_sensitive");
  });

  it("escalates P1 before considering anything else", () => {
    const d = decide(
      input({
        triage: { ...baseTriage, priority: "P1", confidence: 1 },
        kbTopScore: 0.99,
      }),
    );
    expect(d.rule).toBe("priority_p1");
  });

  it("puts hard stops ahead of a matching incident", () => {
    const d = decide(
      input({
        matchedIncidentId: "11111111-1111-1111-1111-111111111111",
        triage: { ...baseTriage, is_destructive_request: true },
      }),
    );
    expect(d.rule).toBe("destructive_request");
  });
});

describe("routing rules", () => {
  it("escalates when the injection scanner tripped, however confident triage was", () => {
    const d = decide(
      input({ injectionSuspected: true, triage: { ...baseTriage, confidence: 1 } }),
    );
    expect(d.rule).toBe("injection_suspected");
    expect(d.path).toBe("escalated");
  });

  it("puts a destructive request ahead of the injection flag", () => {
    // Both are escalations; the recorded reason should be the more specific one.
    const d = decide(
      input({
        injectionSuspected: true,
        triage: { ...baseTriage, is_destructive_request: true },
      }),
    );
    expect(d.rule).toBe("destructive_request");
  });

  it("routes VIPs to a human when the tenant asks for it", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "act", confidence_threshold: 0.8 },
      kb_support_floor: 0.6,
      vip_always_human: true,
    });
    expect(decide(input({ settings, requesterVip: true })).rule).toBe("vip_requester");
    expect(decide(input({ settings, requesterVip: false })).rule).toBe(
      "confident_with_runbook",
    );
  });

  it("leaves VIPs alone when the tenant turns that off", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "act", confidence_threshold: 0.8 },
      kb_support_floor: 0.6,
      vip_always_human: false,
    });
    expect(decide(input({ settings, requesterVip: true })).rule).toBe(
      "confident_with_runbook",
    );
  });

  it("routes configured departments to a human, case-insensitively", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "act", confidence_threshold: 0.8 },
      kb_support_floor: 0.6,
      vip_always_human: false,
      human_only_departments: ["Legal", "Payroll"],
    });
    expect(decide(input({ settings, requesterDepartment: "legal" })).rule).toBe(
      "department_policy",
    );
    expect(decide(input({ settings, requesterDepartment: "Engineering" })).rule).toBe(
      "confident_with_runbook",
    );
    expect(decide(input({ settings, requesterDepartment: null })).rule).toBe(
      "confident_with_runbook",
    );
  });
});

describe("clarify", () => {
  it("asks once when information is missing", () => {
    const d = decide(
      input({ triage: { ...baseTriage, missing_info: ["Exact error message on screen"] } }),
    );
    expect(d.rule).toBe("missing_info");
    expect(d.intendedAction).toBe("ask_question");
    expect(d.status).toBe("awaiting_user");
  });

  it("escalates instead of asking twice", () => {
    const d = decide(
      input({
        clarifyCount: 1,
        triage: { ...baseTriage, missing_info: ["Exact error message on screen"] },
      }),
    );
    expect(d.rule).toBe("clarify_exhausted");
    expect(d.path).toBe("escalated");
  });
});

describe("confidence and support", () => {
  it("escalates below the category threshold", () => {
    const d = decide(input({ triage: { ...baseTriage, confidence: 0.79 } }));
    expect(d.rule).toBe("low_confidence");
  });

  it("uses the per-category threshold, not the default", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "reply", confidence_threshold: 0.7 },
      category_policies: {
        software: { autonomy: "reply", confidence_threshold: 0.98 },
      },
      kb_support_floor: 0.6,
    });
    const confident = { ...baseTriage, category: "software" as const, confidence: 0.95 };
    expect(decide(input({ settings, triage: confident })).rule).toBe("low_confidence");
    expect(
      decide(input({ settings, triage: { ...confident, category: "hardware" } })).rule,
    ).toBe("confident_with_runbook");
  });

  it("refuses to reply with no runbook support", () => {
    expect(decide(input({ kbTopScore: null })).rule).toBe("no_kb_support");
    expect(decide(input({ kbTopScore: 0.4 })).rule).toBe("no_kb_support");
  });

  it("replies when confident and supported", () => {
    const d = decide(input());
    expect(d.rule).toBe("confident_with_runbook");
    expect(d.path).toBe("auto_reply");
    expect(d.status).toBe("resolved");
    expect(d.execute).toBe(true);
  });
});

describe("incident linking", () => {
  it("links rather than answering separately", () => {
    const d = decide(
      input({
        matchedIncidentId: "22222222-2222-2222-2222-222222222222",
        kbTopScore: null, // no runbook needed to say "we know"
      }),
    );
    expect(d.rule).toBe("known_incident");
    expect(d.intendedAction).toBe("link_incident");
  });
});

describe("actions and the whitelist", () => {
  const candidate = { tool: "identity.reset_password", args: { email: "a@b.example" } };

  it("runs a whitelisted action", () => {
    const d = decide(input({ candidateAction: candidate }));
    expect(d.rule).toBe("whitelisted_action");
    expect(d.path).toBe("auto_action");
  });

  it("falls back to a written reply when the tool is not whitelisted", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "act", confidence_threshold: 0.8 },
      kb_support_floor: 0.6,
      auto_action_whitelist: [],
    });
    const d = decide(input({ settings, candidateAction: candidate }));
    expect(d.rule).toBe("confident_with_runbook");
    expect(d.path).toBe("auto_reply");
  });

  it("does not let reply-level autonomy run actions", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "reply", confidence_threshold: 0.8 },
      kb_support_floor: 0.6,
      auto_action_whitelist: ["identity.reset_password"],
    });
    const d = decide(input({ settings, candidateAction: candidate }));
    expect(d.intendedPath).toBe("auto_action");
    expect(d.execute).toBe(false);
    expect(d.status).toBe("awaiting_approval");
  });
});

describe("mode gating", () => {
  it("never contacts the requester in shadow mode", () => {
    for (const kb of [0.99, 0.5, null]) {
      const d = decide(input({ mode: "shadow", kbTopScore: kb }));
      // Escalation is the one thing that still runs, and it talks to nobody.
      if (d.action === "escalate") continue;
      expect(d.execute).toBe(false);
    }
  });

  it("escalates for real even in shadow mode", () => {
    const d = decide(
      input({ mode: "shadow", triage: { ...baseTriage, is_destructive_request: true } }),
    );
    expect(d.action).toBe("escalate");
    expect(d.execute).toBe(true);
  });

  it("still records what it would have done in shadow mode", () => {
    const d = decide(input({ mode: "shadow" }));
    expect(d.intendedPath).toBe("auto_reply");
    expect(d.intendedAction).toBe("send_reply");
    expect(d.path).toBe("human_only");
    expect(d.action).toBe("draft_only");
  });

  it("drafts but does not send in assist mode", () => {
    const d = decide(input({ mode: "assist" }));
    expect(d.action).toBe("draft_only");
    expect(d.execute).toBe(false);
  });

  it("respects per-category autonomy in auto mode", () => {
    const settings = BusinessSettings.parse({
      default_policy: { autonomy: "off", confidence_threshold: 0.8 },
      category_policies: {
        access_identity: { autonomy: "reply", confidence_threshold: 0.8 },
      },
      kb_support_floor: 0.6,
    });
    expect(decide(input({ settings })).execute).toBe(true);
    expect(
      decide(input({ settings, triage: { ...baseTriage, category: "hardware" } })).execute,
    ).toBe(false);
  });

  it("closed-by-default: unknown categories inherit the default policy", () => {
    const settings = BusinessSettings.parse({ kb_support_floor: 0.6 });
    const d = decide(input({ settings, triage: { ...baseTriage, confidence: 1 } }));
    expect(d.autonomy).toBe("off");
    expect(d.execute).toBe(false);
  });
});
