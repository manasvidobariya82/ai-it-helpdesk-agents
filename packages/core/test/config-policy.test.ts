import { describe, expect, it } from "vitest";
import {
  CRITICAL_FIELDS,
  classifyField,
  describeImpact,
  directionOf,
  requiresDualControl,
  type FieldChange,
} from "../src/config-policy.js";
import { BusinessSettings } from "../src/settings.js";
import { diffSettings } from "../src/repos/config.js";

/**
 * Which configuration changes are dangerous, and which way.
 *
 * This is the file that decides whether a change needs `security:update`, a
 * written reason, a confirmation, and a second administrator. Getting the
 * *direction* backwards would be worse than having no gate at all: it would
 * wave the dangerous change through and hold up the brake.
 */

const change = (
  field: string,
  oldValue: unknown,
  newValue: unknown,
): FieldChange => ({
  field,
  old_value: oldValue,
  new_value: newValue,
  risk: classifyField(field),
  direction: directionOf(field, oldValue, newValue),
});

describe("risk classification", () => {
  it("treats every autonomy-governing field as critical", () => {
    for (const field of CRITICAL_FIELDS) {
      expect(classifyField(field), field).toBe("critical");
    }
  });

  it("matches nested fields under a critical prefix", () => {
    expect(classifyField("category_policies.vpn.confidence_threshold")).toBe("critical");
    expect(classifyField("routing.escalate_priorities")).toBe("critical");
    expect(classifyField("default_policy.autonomy")).toBe("critical");
  });

  it("leaves cosmetic and scheduling fields normal", () => {
    expect(classifyField("signature")).toBe("normal");
    expect(classifyField("business_hours.tz")).toBe("normal");
    expect(classifyField("sla.first_response_minutes.P1")).toBe("normal");
  });

  /**
   * A field's name must not be able to sneak past the prefix match. `routing`
   * is critical; `routing_notes` would be a different field and should not
   * inherit the classification by accident in either direction.
   */
  it("does not match on a bare string prefix", () => {
    expect(classifyField("routing_notes")).toBe("normal");
    expect(classifyField("followup_hours_note")).toBe("normal");
  });
});

describe("direction", () => {
  it("reads the autonomy ladder", () => {
    expect(directionOf("category_policies.vpn.autonomy", "off", "reply")).toBe("widening");
    expect(directionOf("category_policies.vpn.autonomy", "act", "suggest")).toBe(
      "narrowing",
    );
    expect(directionOf("category_policies.vpn.autonomy", "off", "off")).toBe("lateral");
  });

  /**
   * The one everybody gets wrong. A *lower* confidence threshold means the
   * agent answers on classifications it is less sure of, which is more
   * autonomy, not less.
   */
  it("treats a lower confidence threshold as widening", () => {
    expect(directionOf("category_policies.vpn.confidence_threshold", 0.9, 0.82)).toBe(
      "widening",
    );
    expect(directionOf("category_policies.vpn.confidence_threshold", 0.82, 0.95)).toBe(
      "narrowing",
    );
  });

  it("treats a lower KB support floor as widening", () => {
    expect(directionOf("kb_support_floor", 0.62, 0.4)).toBe("widening");
    expect(directionOf("kb_support_floor", 0.4, 0.62)).toBe("narrowing");
  });

  it("treats a higher rate limit as widening", () => {
    expect(directionOf("max_agent_runs_per_tenant_hour", 500, 5000)).toBe("widening");
    expect(directionOf("max_agent_runs_per_tenant_hour", 500, 50)).toBe("narrowing");
  });

  it("treats a longer approval window as widening", () => {
    expect(directionOf("approval_expiry_hours", 24, 168)).toBe("widening");
    expect(directionOf("approval_expiry_hours", 24, 1)).toBe("narrowing");
  });

  /**
   * Removing the kill switch is the widest this setting gets: the override only
   * ever narrows what the deployment allows, so taking it off removes a brake.
   */
  it("treats removing the mode override as widening", () => {
    expect(directionOf("agent_mode_override", "shadow", null)).toBe("widening");
    expect(directionOf("agent_mode_override", null, "shadow")).toBe("narrowing");
    expect(directionOf("agent_mode_override", "shadow", "auto")).toBe("widening");
    expect(directionOf("agent_mode_override", "auto", "shadow")).toBe("narrowing");
  });

  it("knows which arrays are permissions and which are restrictions", () => {
    // The whitelist grants: adding to it widens.
    expect(directionOf("auto_action_whitelist", [], ["identity.reset_password"])).toBe(
      "widening",
    );
    expect(directionOf("auto_action_whitelist", ["identity.reset_password"], [])).toBe(
      "narrowing",
    );

    // The never-auto list restricts: removing from it widens.
    expect(directionOf("never_auto_categories", ["security_incident"], [])).toBe(
      "widening",
    );
    expect(directionOf("never_auto_categories", [], ["security_incident"])).toBe(
      "narrowing",
    );
    expect(directionOf("human_only_departments", ["Legal"], [])).toBe("widening");
  });

  it("reports a mixed array edit as widening", () => {
    // Both adding and removing at once. The addition is the half that can hurt,
    // so that is the half the gate should see.
    expect(directionOf("auto_action_whitelist", ["a"], ["b"])).toBe("widening");
  });

  it("treats turning a brake off as widening", () => {
    expect(directionOf("vip_always_human", true, false)).toBe("widening");
    expect(directionOf("vip_always_human", false, true)).toBe("narrowing");
    expect(directionOf("scrub_secrets_at_rest", true, false)).toBe("widening");
    expect(directionOf("require_dual_control_for_widening", true, false)).toBe("widening");
  });

  it("calls a cosmetic edit lateral", () => {
    expect(directionOf("signature", "— IT", "— IT Support")).toBe("lateral");
  });
});

describe("dual control", () => {
  it("is required for a critical widening change", () => {
    expect(
      requiresDualControl(change("category_policies.vpn.confidence_threshold", 0.9, 0.82)),
    ).toBe(true);
    expect(
      requiresDualControl(change("auto_action_whitelist", [], ["identity.reset_password"])),
    ).toBe(true);
  });

  /**
   * The asymmetry this whole design rests on. Somebody who has decided the
   * agent is misbehaving must be able to stop it without finding a colleague;
   * every second spent looking for one is a second the agent is still
   * answering tickets.
   */
  it("is never required to narrow autonomy", () => {
    for (const c of [
      change("category_policies.vpn.confidence_threshold", 0.82, 0.99),
      change("category_policies.vpn.autonomy", "act", "off"),
      change("agent_mode_override", null, "shadow"),
      change("auto_action_whitelist", ["identity.reset_password"], []),
      change("never_auto_categories", [], ["security_incident"]),
      change("vip_always_human", false, true),
    ]) {
      expect(requiresDualControl(c), `${c.field} should not need a second pair of eyes`).toBe(
        false,
      );
    }
  });

  it("is not required for a normal field in either direction", () => {
    expect(requiresDualControl(change("signature", "a", "b"))).toBe(false);
    expect(requiresDualControl(change("business_hours.tz", "UTC", "Europe/London"))).toBe(
      false,
    );
  });
});

describe("impact", () => {
  /**
   * The point of the impact sentence is to turn `0.9 -> 0.82` into a claim
   * about the world, because the number on its own is not something anybody
   * can sanity-check at the moment they are clicking the button.
   */
  it("explains a threshold change in terms of what the agent will do", () => {
    const text = describeImpact(
      change("category_policies.vpn.confidence_threshold", 0.9, 0.82),
    );
    expect(text).toContain("vpn");
    expect(text).toContain("less sure");
    expect(text).toMatch(/82%/);
    expect(text).toMatch(/90%/);
  });

  it("names the tools a whitelist addition unlocks", () => {
    const text = describeImpact(
      change("auto_action_whitelist", [], ["identity.reset_password"]),
    );
    expect(text).toContain("identity.reset_password");
    expect(text).toContain("no approval");
  });

  it("says plainly what removing the kill switch does", () => {
    expect(describeImpact(change("agent_mode_override", "shadow", null))).toContain(
      "Removes the tenant kill switch",
    );
  });

  it("never returns an empty string", () => {
    for (const c of [
      change("signature", "a", "b"),
      change("kb_support_floor", 0.6, 0.4),
      change("followup_hours", 24, 4),
      change("scrub_secrets_at_rest", true, false),
      change("max_clarify_rounds", 1, 3),
      change("routing.default_queue", "tier1", "tier2"),
    ]) {
      expect(describeImpact(c).length, c.field).toBeGreaterThan(0);
    }
  });
});

describe("diffSettings", () => {
  const base = BusinessSettings.parse({});

  it("reports nothing for an identical object", () => {
    expect(diffSettings(base, BusinessSettings.parse({}))).toEqual([]);
  });

  it("finds a nested change and classifies it", () => {
    const next = BusinessSettings.parse({
      ...base,
      category_policies: {
        network_connectivity: { autonomy: "reply", confidence_threshold: 0.82 },
      },
    });
    const changes = diffSettings(base, next);
    const threshold = changes.find((c) =>
      c.field.endsWith("network_connectivity.confidence_threshold"),
    );

    expect(threshold).toBeTruthy();
    expect(threshold!.risk).toBe("critical");
    expect(threshold!.direction).toBe("widening");
    expect(threshold!.old_value).toBeNull();
    expect(threshold!.new_value).toBe(0.82);
  });

  /**
   * Arrays are compared whole rather than per index. `auto_action_whitelist.0`
   * changing from one tool name to another is not a fact anybody wants in an
   * audit log; "the whitelist gained identity.reset_password" is.
   */
  it("treats an array as one field", () => {
    const next = BusinessSettings.parse({
      ...base,
      auto_action_whitelist: ["identity.reset_password"],
    });
    const changes = diffSettings(base, next);
    expect(changes.map((c) => c.field)).toEqual(["auto_action_whitelist"]);
    expect(changes[0]!.direction).toBe("widening");
  });

  it("separates a critical change from a cosmetic one in the same save", () => {
    const next = BusinessSettings.parse({
      ...base,
      signature: "— New Support",
      kb_support_floor: 0.3,
    });
    const changes = diffSettings(base, next);
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));

    expect(byField.signature!.risk).toBe("normal");
    expect(byField.kb_support_floor!.risk).toBe("critical");
    expect(byField.kb_support_floor!.direction).toBe("widening");
  });
});
