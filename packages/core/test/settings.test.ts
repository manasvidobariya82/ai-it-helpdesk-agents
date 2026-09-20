import { describe, expect, it } from "vitest";
import { BusinessSettings, effectiveMode, parseSettings, policyFor } from "../src/settings.js";

describe("defaults", () => {
  it("is closed by default", () => {
    const s = BusinessSettings.parse({});
    expect(s.default_policy.autonomy).toBe("off");
    expect(s.auto_action_whitelist).toEqual([]);
    expect(s.vip_always_human).toBe(true);
    expect(s.agent_mode_override).toBeNull();
  });

  it("falls back to the closed default rather than to whatever parsed", () => {
    // An operator fat-fingers the threshold; autonomy must not survive it.
    const s = parseSettings({
      default_policy: { autonomy: "act", confidence_threshold: 4 },
    });
    expect(s.default_policy.autonomy).toBe("off");
  });

  it("gives unknown categories the default policy", () => {
    const s = BusinessSettings.parse({
      category_policies: { access_identity: { autonomy: "reply", confidence_threshold: 0.9 } },
    });
    expect(policyFor(s, "access_identity").autonomy).toBe("reply");
    expect(policyFor(s, "hardware").autonomy).toBe("off");
  });
});

describe("the kill switch", () => {
  const withOverride = (mode: "shadow" | "assist" | "auto" | null) =>
    BusinessSettings.parse({ agent_mode_override: mode });

  it("narrows the deployment mode", () => {
    expect(effectiveMode("auto", withOverride("shadow"))).toBe("shadow");
    expect(effectiveMode("auto", withOverride("assist"))).toBe("assist");
  });

  it("cannot widen it", () => {
    // A tenant must not be able to switch itself on in a shadow deployment.
    expect(effectiveMode("shadow", withOverride("auto"))).toBe("shadow");
    expect(effectiveMode("assist", withOverride("auto"))).toBe("assist");
  });

  it("is a no-op when unset", () => {
    expect(effectiveMode("auto", withOverride(null))).toBe("auto");
  });
});
