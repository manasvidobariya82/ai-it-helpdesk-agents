import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BusinessSettings,
  EXPECTED_MIGRATION,
  generateApiToken,
  isReady,
  overallStatus,
  publicHealth,
  workerStatus,
  type HealthCheck,
  type HealthReport,
} from "@hd/core";

/**
 * The health policy, with nothing running.
 *
 * What is worth testing here is not whether Postgres answers — that is what the
 * integration suite is for — but the three judgements the report makes: what
 * counts as an outage rather than a degradation, what a monitor is allowed to
 * see, and whether the migration constant still matches reality.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const check = (
  name: string,
  status: HealthCheck["status"],
  extra: Partial<HealthCheck> = {},
): HealthCheck => ({ name, status, latencyMs: 1, ...extra });

const report = (checks: HealthCheck[]): HealthReport => ({
  status: overallStatus(checks),
  checks,
  at: "2026-09-17T09:00:00.000Z",
  uptimeSeconds: 42,
});

// ---------------------------------------------------------------------------

describe("the migration the build expects", () => {
  /**
   * The check that keeps the constant honest.
   *
   * `EXPECTED_MIGRATION` exists to catch a deploy that ran ahead of its
   * migration. A constant nobody updates would report that outage on every
   * healthy deployment instead, which is the same failure in the other
   * direction — so the constant is compared against the directory.
   */
  it("matches the highest-numbered migration on disk", () => {
    const files = fs
      .readdirSync(path.join(repoRoot, "db", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.at(-1)).toBe(EXPECTED_MIGRATION);
  });
});

describe("what counts as down", () => {
  it("is down only when a fatal dependency is", () => {
    // Without a database nothing can be served, so that is an outage.
    expect(
      overallStatus([check("database", "down"), check("redis", "ok")]),
    ).toBe("down");
  });

  it("degrades rather than fails when the agent's dependencies are gone", () => {
    // Redis down means no triage, no delivery and no sweeps — and a person can
    // still open the console and answer a ticket by hand. Calling that a total
    // outage would train whoever is on call to ignore the alert.
    expect(
      overallStatus([check("database", "ok"), check("redis", "down")]),
    ).toBe("degraded");
    expect(
      overallStatus([check("database", "ok"), check("worker", "down")]),
    ).toBe("degraded");
  });

  it("is ok only when everything is", () => {
    expect(overallStatus([check("database", "ok"), check("redis", "ok")])).toBe("ok");
    expect(
      overallStatus([check("database", "ok"), check("model", "degraded")]),
    ).toBe("degraded");
  });

  it("serves traffic while the fatal checks hold", () => {
    // A deployment with no mail transport and no model key is in a deliberate
    // state — shadow mode is the default — and a load balancer draining it
    // would be a self-inflicted outage.
    expect(
      isReady(
        report([
          check("database", "ok"),
          check("outbound_mail", "degraded"),
          check("model", "degraded"),
          check("worker", "down"),
        ]),
      ),
    ).toBe(true);

    expect(isReady(report([check("database", "down")]))).toBe(false);
  });
});

describe("how stale a heartbeat has to be", () => {
  /**
   * Arithmetic on an age, against a 20-second beat. Tested here rather than
   * against a database because the verdict does not need one — and because a
   * test that has to arrange for no worker to be running in order to observe
   * `down` fails depending on what else the developer has open.
   */
  it("tolerates one missed beat and not four", () => {
    expect(workerStatus(0)).toBe("ok");
    expect(workerStatus(20)).toBe("ok");
    // One write missed, then a second: still inside the window.
    expect(workerStatus(45)).toBe("ok");
    expect(workerStatus(90)).toBe("ok");
    expect(workerStatus(91)).toBe("degraded");
    expect(workerStatus(299)).toBe("degraded");
    expect(workerStatus(300)).toBe("degraded");
    // Fifteen missed beats. Whatever this is, it is not a slow write.
    expect(workerStatus(301)).toBe("down");
    expect(workerStatus(86_400)).toBe("down");
  });

  it("makes a dead worker a degradation rather than an outage", () => {
    // The queues have nobody consuming them, which is serious. It is not an
    // outage: a person can still read a queue and answer a ticket, and paging
    // as though the site were down teaches whoever is on call to ignore it.
    const dead = report([check("database", "ok"), check("worker", "down")]);
    expect(overallStatus(dead.checks)).toBe("degraded");
    expect(isReady(dead)).toBe(true);
  });
});

describe("what an unauthenticated monitor may see", () => {
  it("is names and statuses, and nothing else", () => {
    const full = report([
      check("database", "down", {
        detail: "connect ECONNREFUSED 10.0.3.14:5432",
        data: { connections: 41 },
      }),
      check("model", "degraded", { detail: "no model credentials" }),
    ]);

    const seen = publicHealth(full);
    expect(seen).toEqual({
      status: "down",
      at: full.at,
      checks: [
        { name: "database", status: "down" },
        { name: "model", status: "degraded" },
      ],
    });

    // The specific thing this prevents: an error string with an internal
    // hostname in it, served to anybody who can reach the service.
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("10.0.3.14");
    expect(serialized).not.toContain("connections");
    expect(serialized).not.toContain("credentials");
  });
});

describe("api tokens", () => {
  it("are prefixed, long, and never the same twice", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    // The prefix is for humans and for secret scanners: `hd_` in a diff is
    // recognisably a credential.
    expect(a.startsWith("hd_")).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(a).not.toBe(b);
  });
});

describe("the API rate limit is a setting", () => {
  it("defaults to something a normal integration will not notice", () => {
    expect(BusinessSettings.parse({}).api_rate_limit_per_minute).toBe(120);
  });
});
