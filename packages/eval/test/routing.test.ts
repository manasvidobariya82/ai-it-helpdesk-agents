import { BusinessSettings, routeQueue, routingFingerprint } from "@hd/core";
import { describe, expect, it } from "vitest";
import {
  routingByCategory,
  routingOutcome,
  type RoutingSample,
} from "@hd/eval";

const policy = (
  thresholds: Record<string, number>,
  neverAuto: string[] = [],
) => ({
  thresholdFor: (c: string) => thresholds[c] ?? null,
  neverAuto: new Set(neverAuto),
});

function row(
  id: string,
  category: string,
  confidence: number,
  predicted: string,
  actual: string,
  categoryCorrect = predicted === actual,
): RoutingSample {
  return {
    id,
    category,
    confidence,
    predicted_team: predicted,
    actual_team: actual,
    category_correct: categoryCorrect,
  };
}

describe("routeQueue", () => {
  const settings = BusinessSettings.parse({});

  it("reproduces the rule the pipeline used to inline", () => {
    expect(routeQueue("software", "P1", settings)).toBe("oncall");
    expect(routeQueue("software", "P3", settings)).toBe("tier1");
  });

  it("lets priority beat a category override", () => {
    // An outage does not wait in a queue staffed office hours because the
    // classifier called it `software`.
    const withOverride = BusinessSettings.parse({
      routing: { category_queues: { software: "apps" } },
    });
    expect(routeQueue("software", "P3", withOverride)).toBe("apps");
    expect(routeQueue("software", "P1", withOverride)).toBe("oncall");
  });

  it("falls back to the default queue for an unknown category", () => {
    expect(routeQueue("something_new", "P4", settings)).toBe("tier1");
    expect(routeQueue(null, null, settings)).toBe("tier1");
  });

  it("changes its fingerprint when a rule changes", () => {
    const a = routingFingerprint(settings);
    const b = routingFingerprint(
      BusinessSettings.parse({ routing: { category_queues: { hardware: "depot" } } }),
    );
    expect(a).not.toBe(b);
  });
});

describe("routingOutcome", () => {
  it("counts misroutes only among tickets that would auto-route", () => {
    // The point of the metric: mistakes a human was always going to see are
    // not the agent putting work on the wrong desk.
    const rows = [
      row("high-ok", "hardware", 0.95, "tier1", "tier1"),
      row("high-bad", "hardware", 0.96, "tier1", "oncall"),
      row("low-bad", "hardware", 0.40, "tier1", "oncall"),
    ];
    const out = routingOutcome(rows, policy({ hardware: 0.9 }));

    expect(out.routed).toBe(2);
    expect(out.misrouted).toBe(1);
    expect(out.false_routing_rate).toBe(0.5);
    expect(out.held).toBe(1);
    expect(out.held_misrouted).toBe(1);
  });

  it("counts a misclassification that routes to the same team as no misroute", () => {
    // hardware called software, both tier1. One classification error, zero
    // tickets on the wrong desk — which is the number that matters.
    const rows = [row("t1", "software", 0.99, "tier1", "tier1", false)];
    const out = routingOutcome(rows, policy({ software: 0.9 }));
    expect(out.routed).toBe(1);
    expect(out.misrouted).toBe(0);
    expect(out.false_routing_rate).toBe(0);
  });

  it("never auto-routes a category on the never-auto list", () => {
    const rows = [
      row("s1", "security_incident", 1.0, "oncall", "tier1"),
      row("s2", "security_incident", 0.99, "oncall", "oncall"),
    ];
    const out = routingOutcome(
      rows,
      policy({ security_incident: 0.5 }, ["security_incident"]),
    );
    expect(out.routed).toBe(0);
    expect(out.held).toBe(2);
    expect(out.false_routing_rate).toBeNull();
  });

  it("holds everything for a category with no threshold", () => {
    const rows = [row("t1", "other", 0.99, "tier1", "oncall")];
    const out = routingOutcome(rows, policy({}));
    expect(out.routed).toBe(0);
    expect(out.coverage).toBe(0);
    expect(out.false_routing_rate).toBeNull();
  });

  it("reports an upper bound that is pessimistic on thin evidence", () => {
    // Ten routed, none misrouted. The rate is 0 and the honest ceiling is not.
    const rows = Array.from({ length: 10 }, (_v, i) =>
      row(`t${i}`, "hardware", 0.95, "tier1", "tier1"),
    );
    const out = routingOutcome(rows, policy({ hardware: 0.9 }));
    expect(out.false_routing_rate).toBe(0);
    expect(out.false_routing_upper_bound!).toBeGreaterThan(0.25);
  });
});

describe("routingByCategory", () => {
  it("answers the threshold question one category at a time", () => {
    const rows = [
      row("a1", "access_identity", 0.95, "tier1", "tier1"),
      row("a2", "access_identity", 0.93, "tier1", "tier1"),
      row("s1", "security_incident", 0.99, "oncall", "oncall"),
      row("h1", "hardware", 0.50, "tier1", "oncall"),
    ];
    const out = routingByCategory(
      rows,
      policy({ access_identity: 0.9, hardware: 0.9 }, ["security_incident"]),
    );

    const access = out.find((c) => c.category === "access_identity")!;
    expect(access.routed).toBe(2);
    expect(access.threshold).toBe(0.9);

    const security = out.find((c) => c.category === "security_incident")!;
    expect(security.never_auto).toBe(true);
    expect(security.routed).toBe(0);

    const hardware = out.find((c) => c.category === "hardware")!;
    expect(hardware.routed).toBe(0);
    expect(hardware.held).toBe(1);
  });
});
