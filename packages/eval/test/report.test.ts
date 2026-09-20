import { describe, expect, it } from "vitest";
import { DEFAULT_GATES, scoreRun, type ScoredSample } from "@hd/eval";

function sample(
  id: string,
  agent: string,
  human: string,
  confidence: number,
  safety: {
    agentSec?: boolean | null;
    humanSec?: boolean | null;
    agentDest?: boolean | null;
    humanDest?: boolean | null;
    agentTeam?: string | null;
    humanTeam?: string | null;
  } = {},
): ScoredSample {
  return {
    id,
    predicted: {
      category: agent,
      priority: "P3",
      confidence,
      team: safety.agentTeam ?? null,
      is_security_sensitive: safety.agentSec ?? null,
      is_destructive_request: safety.agentDest ?? null,
    },
    actual: {
      category: human,
      priority: "P3",
      team: safety.humanTeam ?? null,
      path: null,
      is_security_sensitive: safety.humanSec ?? null,
      is_destructive_request: safety.humanDest ?? null,
    },
  };
}

const gate = (report: ReturnType<typeof scoreRun>, id: string) =>
  report.gates.find((g) => g.id === id)!;

describe("scoreRun gates", () => {
  it("marks an unlabelled safety slice unmeasured, never passing", () => {
    // The failure mode this guards: a gate with no data reporting green and
    // somebody reading that as "no security tickets were missed".
    const report = scoreRun([sample("1", "hardware", "hardware", 0.9)]);
    expect(gate(report, "safety_slice").status).toBe("unmeasured");
    expect(report.passed).toBe(false);
  });

  it("fails the safety gate on a single miss", () => {
    const report = scoreRun([
      sample("1", "hardware", "hardware", 0.9, { agentSec: false, humanSec: false }),
      sample("2", "hardware", "security_incident", 0.9, {
        agentSec: false,
        humanSec: true,
      }),
    ]);
    const safety = gate(report, "safety_slice");
    expect(safety.status).toBe("fail");
    expect(report.safety.misses).toEqual([{ id: "2", flag: "security_sensitive" }]);
  });

  it("passes the safety gate when every labelled positive was flagged", () => {
    const report = scoreRun([
      sample("1", "security_incident", "security_incident", 0.9, {
        agentSec: true,
        humanSec: true,
      }),
      sample("2", "hardware", "hardware", 0.9, { agentDest: false, humanDest: false }),
    ]);
    expect(gate(report, "safety_slice").status).toBe("pass");
  });

  it("counts an over-flag as a false alarm, not a miss", () => {
    const report = scoreRun([
      sample("1", "hardware", "hardware", 0.9, { agentSec: true, humanSec: false }),
    ]);
    expect(report.safety.misses).toHaveLength(0);
    expect(report.safety.false_alarms).toBe(1);
    expect(gate(report, "safety_slice").status).toBe("pass");
  });

  it("fails the dataset-size gate below the P2 minimum", () => {
    const report = scoreRun([sample("1", "hardware", "hardware", 0.9)]);
    const size = gate(report, "dataset_size");
    expect(size.status).toBe("fail");
    expect(size.note).toContain(`${DEFAULT_GATES.min_dataset_size - 1} more`);
  });

  it("derives the correction rate from category accuracy", () => {
    const report = scoreRun([
      sample("1", "hardware", "hardware", 0.9),
      sample("2", "hardware", "hardware", 0.9),
      sample("3", "hardware", "software", 0.9),
      sample("4", "hardware", "hardware", 0.9),
    ]);
    expect(gate(report, "correction_rate").observed).toBeCloseTo(0.25, 10);
    expect(gate(report, "correction_rate").status).toBe("fail");
  });

  it("reports unmeasured, not failed, when there is nothing to score", () => {
    const report = scoreRun([]);
    expect(gate(report, "category_accuracy").status).toBe("unmeasured");
    expect(gate(report, "calibration_ece").status).toBe("unmeasured");
    expect(gate(report, "dataset_size").status).toBe("unmeasured");
  });

  it("flags a missing category when a taxonomy is supplied", () => {
    const report = scoreRun([sample("1", "hardware", "hardware", 0.9)], {
      samples: [
        {
          id: "1",
          business_id: null,
          created_at: new Date().toISOString(),
          split: "train",
          status: "reviewed",
          label_source: "human_confirmation",
          labeler: "someone@example.com",
          reviewed_at: new Date().toISOString(),
          label_version: "v1",
          input: {
            source: "email",
            subject: "s",
            body: "b",
            attachments: [],
            requester_line: "",
            vip: false,
            device_line: "",
            recent_tickets: "",
            active_incidents: "",
            business_name: "",
            business_type: "",
            fidelity: "reconstructed",
          },
          label: {
            category: "hardware",
            priority: "P3",
            team: null,
            path: null,
            is_security_sensitive: null,
            is_destructive_request: null,
          },
          recorded: null,
          note: null,
        },
      ],
      taxonomy: ["hardware", "software"],
    });
    const coverage = gate(report, "category_coverage");
    expect(coverage.status).toBe("fail");
    expect(coverage.note).toContain("software");
  });
});
