import { describe, expect, it } from "vitest";
import { BusinessSettings, type BusinessHours } from "../src/settings.js";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  computeSla,
  shiftForFirstResponse,
  shiftForPause,
  slaStatus,
  stampForReopen,
  subtractBusinessMinutes,
  toWallClock,
  unrecordedBreaches,
  warningLeadMinutes,
} from "../src/sla.js";

const LONDON: BusinessHours = {
  tz: "Europe/London",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:30",
  holidays: [],
};

const at = (iso: string) => new Date(iso);
const wall = (d: Date, tz = "Europe/London") => {
  const w = toWallClock(d, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
};

describe("business-hours arithmetic", () => {
  it("adds minutes inside the working day", () => {
    // Wednesday 10:00 London (BST, UTC+1) + 90m
    const out = addBusinessMinutes(at("2026-09-16T09:00:00Z"), 90, LONDON);
    expect(wall(out)).toBe("2026-09-16 11:30");
  });

  it("carries over to the next working day rather than running past closing", () => {
    // Wednesday 17:00 London + 60m -> 30m today, 30m from 09:00 Thursday
    const out = addBusinessMinutes(at("2026-09-16T16:00:00Z"), 60, LONDON);
    expect(wall(out)).toBe("2026-09-17 09:30");
  });

  it("does not breach over a weekend", () => {
    // Friday 17:00 London + 60m -> Monday 09:30
    const out = addBusinessMinutes(at("2026-09-18T16:00:00Z"), 60, LONDON);
    expect(wall(out)).toBe("2026-09-21 09:30");
  });

  it("pulls a start before opening forward to the opening", () => {
    // Wednesday 06:00 London + 30m -> 09:30, not 06:30
    const out = addBusinessMinutes(at("2026-09-16T05:00:00Z"), 30, LONDON);
    expect(wall(out)).toBe("2026-09-16 09:30");
  });

  it("skips a configured holiday", () => {
    const withHoliday = { ...LONDON, holidays: ["2026-09-17"] };
    // Wednesday 17:00 + 60m, Thursday is a holiday -> Friday 09:30
    const out = addBusinessMinutes(at("2026-09-16T16:00:00Z"), 60, withHoliday);
    expect(wall(out)).toBe("2026-09-18 09:30");
  });

  it("lands on the expected wall clock across a DST change", () => {
    // Friday 23 Oct 2026 16:00 London (BST); the clocks go back on 25 Oct.
    // 120 business minutes -> 90m to closing on Friday, then 30m from 09:00 on
    // Monday. The answer has to be 09:30 in Monday's wall clock, which is now
    // GMT - naive UTC arithmetic across the boundary lands an hour out.
    const out = addBusinessMinutes(at("2026-10-23T15:00:00Z"), 120, LONDON);
    expect(wall(out)).toBe("2026-10-26 09:30");
    expect(out.toISOString()).toBe("2026-10-26T09:30:00.000Z");
  });

  it("falls back to calendar time on a misconfigured window", () => {
    const broken = { ...LONDON, start: "17:00", end: "09:00" };
    const from = at("2026-09-16T09:00:00Z");
    const out = addBusinessMinutes(from, 60, broken);
    expect(out.getTime()).toBe(from.getTime() + 3_600_000);
  });
});

describe("SLA targets", () => {
  const settings = BusinessSettings.parse({
    business_hours: LONDON,
    sla: {
      first_response_minutes: { P1: 15, P2: 60, P3: 240, P4: 480 },
      resolution_minutes: { P1: 240, P2: 480, P3: 1440, P4: 4320 },
      calendar_priorities: ["P1"],
    },
  });

  it("runs a P1 on the calendar clock, including overnight", () => {
    // Saturday 02:00 UTC. A calendar clock ignores the weekend entirely.
    const sla = computeSla(at("2026-09-19T02:00:00Z"), "P1", settings);
    expect(sla.calendar).toBe(true);
    expect(sla.firstResponseDueAt.toISOString()).toBe("2026-09-19T02:15:00.000Z");
  });

  it("runs a P3 on business hours", () => {
    // Friday 17:00 London + 240 business minutes -> Monday 12:30
    const sla = computeSla(at("2026-09-18T16:00:00Z"), "P3", settings);
    expect(sla.calendar).toBe(false);
    expect(wall(sla.firstResponseDueAt)).toBe("2026-09-21 12:30");
  });
});

describe("SLA status", () => {
  const due = at("2026-09-16T12:00:00Z");

  it("reports breached when the target passed unmet", () => {
    const s = slaStatus(
      {
        first_response_at: null,
        resolved_at: null,
        first_response_due_at: due,
        resolution_due_at: null,
      },
      at("2026-09-16T12:30:00Z"),
    );
    expect(s.firstResponse).toBe("breached");
    expect(s.minutesToNearest).toBe(-30);
  });

  it("reports met when the response beat the target", () => {
    const s = slaStatus(
      {
        first_response_at: at("2026-09-16T11:00:00Z"),
        resolved_at: null,
        first_response_due_at: due,
        resolution_due_at: null,
      },
      at("2026-09-16T12:30:00Z"),
    );
    expect(s.firstResponse).toBe("met");
  });

  it("reports breached when the response arrived after the target", () => {
    const s = slaStatus(
      {
        first_response_at: at("2026-09-16T13:00:00Z"),
        resolved_at: null,
        first_response_due_at: due,
        resolution_due_at: null,
      },
      at("2026-09-16T14:00:00Z"),
    );
    expect(s.firstResponse).toBe("breached");
  });

  it("reports none when no target was ever set", () => {
    const s = slaStatus({
      first_response_at: null,
      resolved_at: null,
      first_response_due_at: null,
      resolution_due_at: null,
    });
    expect(s.firstResponse).toBe("none");
    expect(s.minutesToNearest).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("measuring elapsed business time", () => {
  it("counts only the working part of a span", () => {
    // Wednesday 10:00 to 11:30 London, entirely inside the window.
    expect(
      businessMinutesBetween(
        at("2026-09-16T09:00:00Z"),
        at("2026-09-16T10:30:00Z"),
        LONDON,
      ),
    ).toBe(90);
  });

  it("skips the overnight gap", () => {
    // Wednesday 17:00 to Thursday 09:30 London: 30m before closing, 30m after
    // opening, and fifteen and a half hours that do not count.
    expect(
      businessMinutesBetween(
        at("2026-09-16T16:00:00Z"),
        at("2026-09-17T08:30:00Z"),
        LONDON,
      ),
    ).toBe(60);
  });

  it("skips a weekend", () => {
    // Friday 16:00 to Monday 10:00 London. 90m on Friday, 60m on Monday.
    expect(
      businessMinutesBetween(
        at("2026-09-18T15:00:00Z"),
        at("2026-09-21T09:00:00Z"),
        LONDON,
      ),
    ).toBe(150);
  });

  it("counts a holiday as no time at all", () => {
    const withHoliday: BusinessHours = { ...LONDON, holidays: ["2026-09-17"] };
    // Wednesday 17:00 to Thursday 17:00, where Thursday is a holiday: only the
    // 30 minutes left on Wednesday count.
    expect(
      businessMinutesBetween(
        at("2026-09-16T16:00:00Z"),
        at("2026-09-17T16:00:00Z"),
        withHoliday,
      ),
    ).toBe(30);
  });

  it("is zero for a span entirely outside working hours", () => {
    // Saturday lunchtime to Sunday lunchtime.
    expect(
      businessMinutesBetween(
        at("2026-09-19T11:00:00Z"),
        at("2026-09-20T11:00:00Z"),
        LONDON,
      ),
    ).toBe(0);
  });

  it("is zero when the end is not after the start", () => {
    const t = at("2026-09-16T10:00:00Z");
    expect(businessMinutesBetween(t, t, LONDON)).toBe(0);
    expect(businessMinutesBetween(t, at("2026-09-16T09:00:00Z"), LONDON)).toBe(0);
  });

  it("inverts addBusinessMinutes", () => {
    // The property that matters: whatever the calendar does between two
    // instants, adding the measured minutes to the first lands on the second.
    // Friday afternoon is the interesting case because the span crosses a
    // weekend in one direction and has to unwind it in the other.
    const start = at("2026-09-18T15:00:00Z");
    for (const minutes of [10, 90, 150, 600, 2_400]) {
      const end = addBusinessMinutes(start, minutes, LONDON);
      expect(businessMinutesBetween(start, end, LONDON)).toBe(minutes);
    }
  });

  /** Whole-minute instants across 2026, from a fixed seed. */
  function instants(seed: number) {
    let state = seed;
    const rand = () => (state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    return {
      rand,
      next: () => new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365 * 1440) * 60_000),
    };
  }

  it("stays the inverse of addBusinessMinutes out to the end of the walk", () => {
    // Fuzzed, because the defect this guards lived at spans nobody writes by
    // hand. The two walks used to give up at different distances — about 233
    // calendar days for the adding walk and 400 for the measuring one — and a
    // span in between was measured in business minutes and added back as
    // calendar ones. The spans here run from minutes to just past 400 days;
    // the 880-day case below covers the calendar fallback on its own.
    const { rand, next } = instants(20_260_918);
    const maxDays = [3, 60, 420];

    for (let i = 0; i < 120; i++) {
      const from = next();
      const to = new Date(from.getTime() + Math.floor(rand() * maxDays[i % 3]! * 1440) * 60_000);

      const landed = addBusinessMinutes(from, businessMinutesBetween(from, to, LONDON), LONDON);
      // Out of hours, many instants are the same business instant: nothing
      // workable separates 17:30 Friday from 08:00 Monday. So landing on `to`
      // means no working time between the two, not an equal timestamp.
      const [lo, hi] = landed < to ? [landed, to] : [to, landed];
      expect(businessMinutesBetween(lo, hi, LONDON)).toBe(0);
    }

    // And the other way round, for every budget the walk can spend without
    // falling back — up to about eleven months of working time.
    for (let i = 0; i < 60; i++) {
      const from = next();
      const budget = Math.floor(rand() * 120_000);
      const end = addBusinessMinutes(from, budget, LONDON);
      expect(businessMinutesBetween(from, end, LONDON)).toBe(budget);
    }
  });

  it("falls back to calendar time past the walk, where addBusinessMinutes does", () => {
    // 880 days is a configuration error, not a ticket. The measurement used to
    // hit its guard and return the partial total, while the adding walk fell
    // back to calendar time in the same situation, so the pair silently
    // stopped being inverses and the pause was under-credited. Both fall back
    // now, and adding the measurement back lands exactly where it started.
    const from = at("2026-01-05T10:00:00Z");
    const to = new Date(from.getTime() + 880 * 86_400_000);
    const measured = businessMinutesBetween(from, to, LONDON);
    expect(measured).toBe(880 * 1440);
    expect(addBusinessMinutes(from, measured, LONDON).toISOString()).toBe(to.toISOString());
  });

  it("walks back exactly what addBusinessMinutes walked forward", () => {
    // `shiftForPause` derives the warning by walking back from the deadline,
    // so the backwards walk has to agree with the forward one about what a
    // working minute is — weekends, the overnight gap and closing time included.
    const { rand, next } = instants(1_789);
    for (let i = 0; i < 300; i++) {
      const from = next();
      const minutes = 1 + Math.floor(rand() * 5_000);
      const back = subtractBusinessMinutes(addBusinessMinutes(from, minutes, LONDON), minutes, LONDON);
      const [lo, hi] = back < from ? [back, from] : [from, back];
      expect(businessMinutesBetween(lo, hi, LONDON)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the warning threshold", () => {
  /**
   * The defect this replaces: `slaStatus` decided "due soon" at
   * `Math.max(15, 0)` — a flat fifteen minutes, with a second argument that was
   * never filled in — while the notification sweep used a share of the window.
   * The two disagreed in both directions at once.
   */
  it("is a share of the window, so it scales with the window", () => {
    // A P1's fifteen minutes and a P4's three days cannot share a fixed lead.
    expect(warningLeadMinutes(15, 20)).toBe(3);
    expect(warningLeadMinutes(4_320, 20)).toBe(864);
  });

  it("has no floor, so a short window is not born at risk", () => {
    // The old flat 15 would have marked a fifteen-minute P1 due_soon at the
    // moment it arrived, which is a warning that carries no information.
    expect(warningLeadMinutes(15, 20)).toBeLessThan(15);
  });

  it("honours the tenant's configured share", () => {
    expect(warningLeadMinutes(600, 10)).toBe(60);
    expect(warningLeadMinutes(600, 50)).toBe(300);
  });

  it("stamps the warning instant on the same calendar as the deadline", () => {
    const settings = BusinessSettings.parse({
      business_hours: LONDON,
      sla: {
        first_response_minutes: { P1: 15, P2: 60, P3: 240, P4: 480 },
        resolution_minutes: { P1: 240, P2: 480, P3: 1440, P4: 4320 },
        calendar_priorities: ["P1"],
      },
      notifications: { sla_warning_at_percent: 25 },
    });

    // Friday 16:00 London, P3: 240 business minutes to first response is 90
    // left on Friday plus 150 from Monday's opening, landing Monday 11:30. The
    // warning is a quarter of the window earlier — Monday 10:30, inside working
    // hours rather than at 2am on Sunday.
    const sla = computeSla(at("2026-09-18T15:00:00Z"), "P3", settings);
    expect(wall(sla.firstResponseDueAt)).toBe("2026-09-21 11:30");
    expect(wall(sla.firstResponseWarnAt)).toBe("2026-09-21 10:30");

    // A P1 is on the calendar clock, so its warning is too.
    const p1 = computeSla(at("2026-09-19T02:00:00Z"), "P1", settings);
    expect(p1.firstResponseWarnAt.toISOString()).toBe("2026-09-19T02:11:00.000Z");
  });
});

// ---------------------------------------------------------------------------

describe("pausing the clock", () => {
  const settings = BusinessSettings.parse({
    business_hours: LONDON,
    sla: {
      first_response_minutes: { P1: 15, P2: 60, P3: 240, P4: 480 },
      resolution_minutes: { P1: 240, P2: 480, P3: 1440, P4: 4320 },
      calendar_priorities: ["P1"],
    },
    notifications: { sla_warning_at_percent: 20 },
  });

  const clocks = (dueIso: string, warnIso: string) => ({
    first_response_due_at: at(dueIso),
    resolution_due_at: at(dueIso),
    first_response_warn_at: at(warnIso),
    resolution_warn_at: at(warnIso),
  });

  it("gives back exactly the business time the requester held", () => {
    // Paused Wednesday 10:00, resumed 11:30 London: 90 working minutes, so
    // every clock moves 90 working minutes later.
    const shift = shiftForPause(
      clocks("2026-09-16T14:00:00Z", "2026-09-16T13:00:00Z"),
      at("2026-09-16T09:00:00Z"),
      at("2026-09-16T10:30:00Z"),
      "P3",
      settings,
    );
    expect(shift.pausedMinutes).toBe(90);
    expect(wall(shift.resolutionDueAt!)).toBe("2026-09-16 16:30");
    expect(wall(shift.resolutionWarnAt!)).toBe("2026-09-16 15:30");
  });

  it("keeps the warning ahead of the deadline when both sit out of hours", () => {
    // Warning Wednesday 18:56, deadline 19:31 London: the shape the 0015
    // backfill writes when a calendar-derived warning lands in the evening.
    // `addBusinessMinutes` sends every out-of-hours instant to the same next
    // opening, so shifting the two independently put both on Thursday at 10:28
    // and the warning fired at the moment of breach. The 35-minute lead has to
    // survive the shift.
    const shift = shiftForPause(
      clocks("2026-09-16T18:31:00Z", "2026-09-16T17:56:00Z"),
      at("2026-09-16T08:00:00Z"),
      at("2026-09-16T09:28:00Z"),
      "P3",
      settings,
    );
    expect(shift.pausedMinutes).toBe(88);
    expect(wall(shift.resolutionDueAt!)).toBe("2026-09-17 10:28");
    expect(wall(shift.resolutionWarnAt!)).toBe("2026-09-17 09:53");
    expect(wall(shift.firstResponseWarnAt!)).toBe("2026-09-17 09:53");
  });

  it("keeps the working-time lead when the warning and deadline straddle closing", () => {
    // Warning 17:10, deadline 17:45: twenty working minutes apart, not
    // thirty-five, and it is the working minutes that carry over.
    const shift = shiftForPause(
      clocks("2026-09-16T16:45:00Z", "2026-09-16T16:10:00Z"),
      at("2026-09-16T08:00:00Z"),
      at("2026-09-16T09:28:00Z"),
      "P3",
      settings,
    );
    expect(wall(shift.resolutionDueAt!)).toBe("2026-09-17 10:28");
    expect(wall(shift.resolutionWarnAt!)).toBe("2026-09-17 10:08");
  });

  it("does not hand back a weekend on a business-hours clock", () => {
    // The whole reason the pause is measured in business minutes. Friday 16:00
    // to Monday 10:00 is 66 calendar hours and 150 working ones.
    const shift = shiftForPause(
      clocks("2026-09-21T13:00:00Z", "2026-09-21T12:00:00Z"),
      at("2026-09-18T15:00:00Z"),
      at("2026-09-21T09:00:00Z"),
      "P3",
      settings,
    );
    expect(shift.pausedMinutes).toBe(150);
    // Monday 14:00 + 150 working minutes = Monday 16:30, not Wednesday.
    expect(wall(shift.resolutionDueAt!)).toBe("2026-09-21 16:30");
  });

  it("does hand back the whole span on a calendar clock", () => {
    // A P1 runs on calendar time, so a pause over a weekend returns the
    // weekend. Anything else would mean the two clocks disagreed about what a
    // minute is.
    const shift = shiftForPause(
      clocks("2026-09-21T13:00:00Z", "2026-09-21T12:00:00Z"),
      at("2026-09-18T15:00:00Z"),
      at("2026-09-21T09:00:00Z"),
      "P1",
      settings,
    );
    expect(shift.pausedMinutes).toBe(66 * 60);
  });

  it("treats an untriaged ticket as calendar time", () => {
    // No priority means no policy to look up, and guessing a business-hours
    // clock for a ticket nobody has classified would quietly shorten it.
    const shift = shiftForPause(
      clocks("2026-09-21T13:00:00Z", "2026-09-21T12:00:00Z"),
      at("2026-09-19T10:00:00Z"),
      at("2026-09-19T11:00:00Z"),
      null,
      settings,
    );
    expect(shift.pausedMinutes).toBe(60);
  });

  it("is a no-op when no time passed", () => {
    const t = at("2026-09-16T09:00:00Z");
    const shift = shiftForPause(
      clocks("2026-09-16T14:00:00Z", "2026-09-16T13:00:00Z"),
      t,
      t,
      "P3",
      settings,
    );
    expect(shift.pausedMinutes).toBe(0);
    expect(shift.resolutionDueAt!.toISOString()).toBe("2026-09-16T14:00:00.000Z");
  });

  it("leaves a clock that was never set alone", () => {
    const shift = shiftForPause(
      {
        first_response_due_at: null,
        resolution_due_at: null,
        first_response_warn_at: null,
        resolution_warn_at: null,
      },
      at("2026-09-16T09:00:00Z"),
      at("2026-09-16T10:00:00Z"),
      "P3",
      settings,
    );
    expect(shift.resolutionDueAt).toBeNull();
    expect(shift.firstResponseWarnAt).toBeNull();
    expect(shift.pausedMinutes).toBe(60);
    expect(shift.settled).toEqual([]);
  });

  it("leaves a clock whose outcome is recorded where it was", () => {
    // Answered before the pause began. The resolution clock was stopped and is
    // given the time back; the first-response clock was not, and is not.
    const before = {
      ...clocks("2026-09-16T14:00:00Z", "2026-09-16T13:00:00Z"),
      first_response_due_at: at("2026-09-16T09:30:00Z"),
      first_response_warn_at: at("2026-09-16T09:20:00Z"),
      first_response_at: at("2026-09-16T09:45:00Z"),
      resolved_at: null,
    };
    const shift = shiftForPause(
      before,
      at("2026-09-16T10:00:00Z"),
      at("2026-09-16T11:00:00Z"),
      "P3",
      settings,
    );
    expect(shift.settled).toEqual(["first_response"]);
    expect(shift.firstResponseDueAt).toEqual(before.first_response_due_at);
    expect(shift.firstResponseWarnAt).toEqual(before.first_response_warn_at);
    expect(wall(shift.resolutionDueAt!)).toBe("2026-09-16 16:00");
    expect(shift.pausedMinutes).toBe(60);
  });

  it("treats an outcome with no deadline to judge it against as nothing to keep", () => {
    const shift = shiftForPause(
      {
        ...clocks("2026-09-16T14:00:00Z", "2026-09-16T13:00:00Z"),
        first_response_due_at: null,
        first_response_warn_at: null,
        first_response_at: at("2026-09-16T08:00:00Z"),
      },
      at("2026-09-16T09:00:00Z"),
      at("2026-09-16T10:00:00Z"),
      "P3",
      settings,
    );
    expect(shift.settled).toEqual([]);
    expect(shift.firstResponseDueAt).toBeNull();
  });

  it("accumulates across repeated cycles", () => {
    // Three pauses on one Wednesday: 30, 60 and 15 working minutes. The
    // deadline should end up 105 minutes later than it started, which is the
    // property a single-pause implementation gets wrong.
    let due = at("2026-09-16T14:00:00Z");
    let warn = at("2026-09-16T13:00:00Z");
    let total = 0;

    const cycles: [string, string][] = [
      ["2026-09-16T08:00:00Z", "2026-09-16T08:30:00Z"],
      ["2026-09-16T09:00:00Z", "2026-09-16T10:00:00Z"],
      ["2026-09-16T10:30:00Z", "2026-09-16T10:45:00Z"],
    ];

    for (const [paused, resumed] of cycles) {
      const shift = shiftForPause(
        {
          first_response_due_at: due,
          resolution_due_at: due,
          first_response_warn_at: warn,
          resolution_warn_at: warn,
        },
        at(paused),
        at(resumed),
        "P3",
        settings,
      );
      due = shift.resolutionDueAt!;
      warn = shift.resolutionWarnAt!;
      total += shift.pausedMinutes;
    }

    expect(total).toBe(105);
    expect(wall(due)).toBe("2026-09-16 16:45");
    // The warning keeps its distance from the deadline across every cycle.
    expect(wall(warn)).toBe("2026-09-16 15:45");
  });
});

// ---------------------------------------------------------------------------

describe("what a paused ticket reports", () => {
  const base = {
    first_response_at: at("2026-09-16T09:00:00Z"),
    resolved_at: null,
    first_response_due_at: at("2026-09-16T09:30:00Z"),
    first_response_warn_at: at("2026-09-16T09:20:00Z"),
    resolution_due_at: at("2026-09-16T14:00:00Z"),
    resolution_warn_at: at("2026-09-16T13:00:00Z"),
  };

  it("reports paused rather than a countdown that is not counting down", () => {
    const s = slaStatus(
      { ...base, sla_paused_at: at("2026-09-16T10:00:00Z"), sla_paused_minutes: 45 },
      at("2026-09-16T11:00:00Z"),
    );
    expect(s.resolution).toBe("paused");
    expect(s.paused).toBe(true);
    expect(s.pausedMinutes).toBe(45);
  });

  it("still reports a breach that happened before the clock stopped", () => {
    // Pausing cannot un-breach a deadline that had already gone past; hiding
    // it behind "paused" would lose the one state somebody has to act on.
    const s = slaStatus(
      { ...base, sla_paused_at: at("2026-09-16T14:30:00Z"), sla_paused_minutes: 10 },
      at("2026-09-16T16:00:00Z"),
    );
    expect(s.resolution).toBe("breached");
    // Thirty minutes late when it stopped, and still thirty: a stopped clock
    // accumulates lateness no more than it accumulates time.
    expect(s.minutesToNearest).toBe(-30);
  });

  it("does not call a deadline that passes while the clock is stopped a breach", () => {
    // This test used to assert `breached` here, for a pause that began an hour
    // *before* the deadline. The resume gives those hours back, so the ticket
    // then read `on_track` again — which is what made it look as though a
    // resume could clear a breach. There was never one to clear.
    const s = slaStatus(
      { ...base, sla_paused_at: at("2026-09-16T13:00:00Z"), sla_paused_minutes: 10 },
      at("2026-09-16T15:00:00Z"),
    );
    expect(s.resolution).toBe("paused");
    expect(s.minutesToNearest).toBeNull();
  });

  it("still reports an outcome that is already decided", () => {
    const s = slaStatus(
      {
        ...base,
        resolved_at: at("2026-09-16T12:00:00Z"),
        sla_paused_at: at("2026-09-16T12:30:00Z"),
      },
      at("2026-09-16T13:00:00Z"),
    );
    expect(s.resolution).toBe("met");
  });

  it("counts down again once the clock restarts", () => {
    const s = slaStatus(
      { ...base, sla_paused_at: null, sla_paused_minutes: 45 },
      at("2026-09-16T11:00:00Z"),
    );
    expect(s.resolution).toBe("on_track");
    expect(s.paused).toBe(false);
    expect(s.pausedMinutes).toBe(45);
    expect(s.minutesToNearest).toBe(180);
  });
});

// ---------------------------------------------------------------------------

describe("due soon", () => {
  const clocks = {
    first_response_at: at("2026-09-16T09:00:00Z"),
    resolved_at: null,
    first_response_due_at: null,
    first_response_warn_at: null,
    resolution_due_at: at("2026-09-16T14:00:00Z"),
    resolution_warn_at: at("2026-09-16T13:00:00Z"),
  };

  it("is on_track before the warning instant", () => {
    expect(slaStatus(clocks, at("2026-09-16T12:59:00Z")).resolution).toBe("on_track");
  });

  it("is due_soon exactly at the warning instant", () => {
    // The boundary is inclusive. A threshold that only fires strictly after it
    // depends on how often the sweep runs to be reached at all.
    expect(slaStatus(clocks, at("2026-09-16T13:00:00Z")).resolution).toBe("due_soon");
  });

  it("is due_soon between the warning instant and the deadline", () => {
    expect(slaStatus(clocks, at("2026-09-16T13:59:00Z")).resolution).toBe("due_soon");
  });

  it("is still due_soon at the deadline instant, and breached after it", () => {
    // "Due at 14:00" means 14:00 is on time, which is the same boundary `met`
    // uses for a response that lands exactly on the deadline. The two have to
    // agree or a ticket answered at its deadline reads as met and breached.
    expect(slaStatus(clocks, at("2026-09-16T14:00:00Z")).resolution).toBe("due_soon");
    expect(slaStatus(clocks, at("2026-09-16T14:01:00Z")).resolution).toBe("breached");
  });

  it("degrades to on_track when no warning instant was ever stamped", () => {
    // Tickets stamped before this column existed, and tickets never triaged.
    // Guessing a window from created_at is what the old code did, and it is
    // what made the console and the sweep disagree.
    const legacy = { ...clocks, resolution_warn_at: null };
    expect(slaStatus(legacy, at("2026-09-16T13:59:00Z")).resolution).toBe("on_track");
    expect(slaStatus(legacy, at("2026-09-16T14:01:00Z")).resolution).toBe("breached");
  });

  it("warns a P1 in minutes and a P4 in hours, from one rule", () => {
    // The end-to-end statement of the fix. Both are stamped by computeSla and
    // read by slaStatus; neither has a fixed lead written anywhere.
    const settings = BusinessSettings.parse({
      business_hours: LONDON,
      sla: {
        first_response_minutes: { P1: 15, P2: 60, P3: 240, P4: 480 },
        resolution_minutes: { P1: 240, P2: 480, P3: 1440, P4: 4320 },
        calendar_priorities: ["P1", "P2", "P3", "P4"],
      },
      notifications: { sla_warning_at_percent: 20 },
    });
    const created = at("2026-09-16T09:00:00Z");

    const p1 = computeSla(created, "P1", settings);
    const p4 = computeSla(created, "P4", settings);

    const leadMinutes = (due: Date, warn: Date) =>
      Math.round((due.getTime() - warn.getTime()) / 60_000);

    // 20% of a 15-minute target is 3 minutes.
    expect(leadMinutes(p1.firstResponseDueAt, p1.firstResponseWarnAt)).toBe(3);
    // 20% of a three-day resolution target is most of a working day.
    expect(leadMinutes(p4.resolutionDueAt, p4.resolutionWarnAt)).toBe(864);

    // And the old behaviour, asserted as gone: a P4 is not due_soon fifteen
    // minutes before its deadline — it has been due_soon for fourteen hours.
    const fifteenBefore = new Date(p4.resolutionDueAt.getTime() - 15 * 60_000);
    const dayBefore = new Date(p4.resolutionDueAt.getTime() - 20 * 60 * 60_000);
    const p4Clocks = {
      first_response_at: created,
      resolved_at: null,
      first_response_due_at: null,
      first_response_warn_at: null,
      resolution_due_at: p4.resolutionDueAt,
      resolution_warn_at: p4.resolutionWarnAt,
    };
    expect(slaStatus(p4Clocks, fifteenBefore).resolution).toBe("due_soon");
    expect(slaStatus(p4Clocks, dayBefore).resolution).toBe("on_track");
  });
});

// ---------------------------------------------------------------------------

/**
 * Every transition in `docs/sla.md`, without a database.
 *
 * `machine` makes the column writes `setStatus` and a retriage make, using the
 * same pure functions they call, so each row of the spec's transition table is
 * one assertion here. What only a database can prove — the races, the event
 * log, the status routing — is in the `*.integration.test.ts` suites, and the
 * spec names which test covers which row.
 */
type Clocks = {
  first_response_at: Date | null;
  resolved_at: Date | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_response_warn_at: Date | null;
  resolution_warn_at: Date | null;
  sla_paused_at: Date | null;
  sla_paused_minutes: number;
  sla_resolved_minutes?: number;
  first_response_breached_at?: Date | null;
  resolution_breached_at?: Date | null;
  resolution_clock_breached?: boolean;
};

function machine(settings: BusinessSettings, priority: "P1" | "P2" | "P3" | "P4") {
  const stamp = (created: Date, credit = 0): Clocks => {
    const s = computeSla(created, priority, settings, credit);
    return {
      first_response_at: null,
      resolved_at: null,
      first_response_due_at: s.firstResponseDueAt,
      resolution_due_at: s.resolutionDueAt,
      first_response_warn_at: s.firstResponseWarnAt,
      resolution_warn_at: s.resolutionWarnAt,
      sla_paused_at: null,
      sla_paused_minutes: 0,
    };
  };
  // What `recordBreaches` writes: every breach the clocks show and have not
  // recorded. The first breach of the resolution target stays first.
  const record = (t: Clocks, when: Date): Clocks => {
    let next = t;
    for (const b of unrecordedBreaches(t, when)) {
      next =
        b.clock === "first_response"
          ? { ...next, first_response_breached_at: b.breachedAt }
          : {
              ...next,
              resolution_breached_at: next.resolution_breached_at ?? b.breachedAt,
              resolution_clock_breached: true,
            };
    }
    return next;
  };
  // Every clock writer records what the row shows before its change, and what
  // the change produced after it.
  const write = (t: Clocks, when: Date, change: (u: Clocks) => Clocks): Clocks =>
    record(change(record(t, when)), when);

  // Out of `resolved` or `closed`: a new resolution clock, with the old
  // clock's breach left in `resolution_breached_at`.
  const unresolve = (t: Clocks): Clocks =>
    t.resolved_at ? { ...t, resolved_at: null, resolution_clock_breached: false } : t;
  const credit = (t: Clocks, when: Date): Clocks => {
    if (!t.sla_paused_at) return t;
    const s = shiftForPause(t, t.sla_paused_at, when, priority, settings);
    return {
      ...t,
      first_response_due_at: s.firstResponseDueAt,
      resolution_due_at: s.resolutionDueAt,
      first_response_warn_at: s.firstResponseWarnAt,
      resolution_warn_at: s.resolutionWarnAt,
      sla_paused_at: null,
      sla_paused_minutes: t.sla_paused_minutes + s.pausedMinutes,
    };
  };

  // Into `awaiting_user`. A second pause is not a second pause.
  const pause = (t: Clocks, when: Date): Clocks =>
    write(t, when, (u) => (u.sla_paused_at ? u : { ...unresolve(u), sla_paused_at: when }));
  // Out of `awaiting_user`, to any other status.
  const resume = (t: Clocks, when: Date): Clocks => write(t, when, (u) => credit(u, when));
  const resolve = (t: Clocks, when: Date): Clocks =>
    write(t, when, (u) => ({ ...credit(u, when), resolved_at: u.resolved_at ?? when }));
  // A reopen at `when`, as `setStatus` does it (D3). The new resolution clock
  // is credited the time since the resolution and stamped from `created` for
  // the priority the ticket has now, `to`.
  const reopen = (t: Clocks, created: Date, when: Date, to = priority): Clocks =>
    write(t, when, (u) => {
      if (!u.resolved_at) return u;
      const resolvedBefore = u.sla_resolved_minutes ?? 0;
      const r = stampForReopen(
        {
          created_at: created,
          resolved_at: u.resolved_at,
          sla_paused_minutes: u.sla_paused_minutes,
          sla_resolved_minutes: resolvedBefore,
        },
        when,
        to,
        settings,
      );
      return {
        ...unresolve(u),
        sla_resolved_minutes: resolvedBefore + r.resolvedMinutes,
        resolution_due_at: r.stamp!.resolutionDueAt,
        resolution_warn_at: r.stamp!.resolutionWarnAt,
      };
    });
  // The first reply, once. While paused it settles the first-response clock
  // with the part of the pause before it, as `markFirstResponse` does.
  const respond = (t: Clocks, when: Date): Clocks => {
    if (t.first_response_at) return t;
    return write(t, when, (u) => {
      if (!u.sla_paused_at || !u.first_response_due_at) return { ...u, first_response_at: when };
      const s = shiftForFirstResponse(u, u.sla_paused_at, when, priority, settings);
      return {
        ...u,
        first_response_at: when,
        first_response_due_at: s.dueAt,
        first_response_warn_at: s.warnAt,
      };
    });
  };
  // A person changing the priority (T15), or a retriage (T14): running clocks
  // are stamped again from `created_at`, and a clock whose result is recorded,
  // an outcome or a breach, keeps its deadline (`SETTLED_CLOCKS`).
  const reclassify = (
    t: Clocks,
    created: Date,
    to: "P1" | "P2" | "P3" | "P4",
    when: Date,
  ): Clocks =>
    write(t, when, (u) => {
      const s = computeSla(created, to, settings, u.sla_paused_minutes);
      const keepFirst = u.first_response_due_at && (u.first_response_at || u.first_response_breached_at);
      const keepResolution = u.resolution_due_at && (u.resolved_at || u.resolution_clock_breached);
      return {
        ...u,
        first_response_due_at: keepFirst ? u.first_response_due_at : s.firstResponseDueAt,
        first_response_warn_at: keepFirst ? u.first_response_warn_at : s.firstResponseWarnAt,
        resolution_due_at: keepResolution ? u.resolution_due_at : s.resolutionDueAt,
        resolution_warn_at: keepResolution ? u.resolution_warn_at : s.resolutionWarnAt,
      };
    });
  return { stamp, record, pause, resume, resolve, reopen, respond, reclassify };
}

describe("the SLA state machine", () => {
  // Every priority on the calendar clock, so the assertions can talk in wall
  // minutes. P3 here: first response in 60 (warning 12 before), resolution in
  // 240 (warning 48 before). The business clock has its own block below.
  const settings = BusinessSettings.parse({
    business_hours: LONDON,
    sla: {
      first_response_minutes: { P1: 15, P2: 30, P3: 60, P4: 480 },
      resolution_minutes: { P1: 120, P2: 180, P3: 240, P4: 4320 },
      calendar_priorities: ["P1", "P2", "P3", "P4"],
    },
    notifications: { sla_warning_at_percent: 20 },
  });
  const m = machine(settings, "P3");
  const created = at("2026-09-16T09:00:00Z");
  // Resolution due 13:00, warning at 12:12. First response due 10:00.
  const fresh = () => ({ ...m.stamp(created), first_response_at: at("2026-09-16T09:30:00Z") });
  const status = (t: Clocks, iso: string) => slaStatus(t, at(iso));

  it("T1 stamping starts a clock that is on track", () => {
    const s = status(m.stamp(created), "2026-09-16T09:00:00Z");
    expect(s.firstResponse).toBe("on_track");
    expect(s.resolution).toBe("on_track");
    expect(s.minutesToNearest).toBe(60);
  });

  it("T2 a running clock is due_soon from its warning instant", () => {
    expect(status(fresh(), "2026-09-16T12:11:00Z").resolution).toBe("on_track");
    expect(status(fresh(), "2026-09-16T12:12:00Z").resolution).toBe("due_soon");
  });

  it("T3 a running clock breaches once its deadline passes", () => {
    expect(status(fresh(), "2026-09-16T13:00:00Z").resolution).toBe("due_soon");
    const s = status(fresh(), "2026-09-16T13:05:00Z");
    expect(s.resolution).toBe("breached");
    expect(s.minutesToNearest).toBe(-5);
  });

  it("T4 pausing an on-track or due-soon clock reports paused", () => {
    const early = m.pause(fresh(), at("2026-09-16T10:30:00Z"));
    const late = m.pause(fresh(), at("2026-09-16T12:30:00Z"));
    expect(status(early, "2026-09-16T10:31:00Z").resolution).toBe("paused");
    expect(status(late, "2026-09-16T12:31:00Z").resolution).toBe("paused");
  });

  it("T6 I1 a stopped clock reports the same thing whatever the time", () => {
    // The invariant that makes the rest hold: nothing about a stopped clock is
    // a function of the wall clock. Before, the last three of these read
    // `breached`, because the stored deadline had not moved yet.
    const t = m.pause(fresh(), at("2026-09-16T12:00:00Z"));
    for (const iso of [
      "2026-09-16T12:30:00Z",
      "2026-09-16T13:00:00Z",
      "2026-09-16T13:01:00Z",
      "2026-09-16T18:00:00Z",
      "2026-09-23T12:00:00Z",
    ]) {
      const s = status(t, iso);
      expect(s.resolution, iso).toBe("paused");
      expect(s.minutesToNearest, iso).toBeNull();
    }
  });

  it("T7 resuming gives back the margin the clock stopped with", () => {
    // Stopped with 150 minutes in hand, resumed five and a half hours later.
    const t = m.resume(m.pause(fresh(), at("2026-09-16T10:30:00Z")), at("2026-09-16T16:00:00Z"));
    const s = status(t, "2026-09-16T16:00:00Z");
    expect(s.resolution).toBe("on_track");
    expect(s.minutesToNearest).toBe(150);
    expect(t.sla_paused_minutes).toBe(330);
  });

  it("T7 a clock paused inside its warning window resumes inside it", () => {
    // Stopped at 12:30 with 30 minutes left, which was already due_soon.
    const t = m.resume(m.pause(fresh(), at("2026-09-16T12:30:00Z")), at("2026-09-16T15:00:00Z"));
    const s = status(t, "2026-09-16T15:00:00Z");
    expect(s.resolution).toBe("due_soon");
    expect(s.minutesToNearest).toBe(30);
  });

  it("T6 T7 a deadline that passes during a pause is not a breach, during it or after", () => {
    // The shape of the old E2 integration test, which read as "a resume can
    // clear an existing breach". With the stopped clock read at the instant it
    // stopped, nothing was ever reported as breached, so nothing is cleared.
    const paused = m.pause(fresh(), at("2026-09-16T12:00:00Z"));
    expect(status(paused, "2026-09-16T14:00:00Z").resolution).toBe("paused");
    const s = status(m.resume(paused, at("2026-09-16T14:00:00Z")), "2026-09-16T14:00:00Z");
    expect(s.resolution).toBe("on_track");
    expect(s.minutesToNearest).toBe(60);
  });

  it("T5 T8 I2 a breach before the pause stays breached through it and after it", () => {
    // Thirty minutes late at 13:30; the requester then holds it for three and
    // a half hours. It is thirty minutes late throughout, and afterwards.
    const paused = m.pause(fresh(), at("2026-09-16T13:30:00Z"));
    for (const iso of ["2026-09-16T13:31:00Z", "2026-09-16T16:00:00Z"]) {
      const s = status(paused, iso);
      expect(s.resolution, iso).toBe("breached");
      expect(s.minutesToNearest, iso).toBe(-30);
    }
    const after = m.resume(paused, at("2026-09-16T17:00:00Z"));
    const s = status(after, "2026-09-16T17:00:00Z");
    expect(s.resolution).toBe("breached");
    expect(s.minutesToNearest).toBe(-30);
  });

  it("T9 resolving in time is met, and stays met", () => {
    const t = m.resolve(fresh(), at("2026-09-16T12:30:00Z"));
    expect(status(t, "2026-09-16T12:30:00Z").resolution).toBe("met");
    expect(status(t, "2026-09-18T12:00:00Z").resolution).toBe("met");
  });

  it("T10 I4 resolving late is breached, and stays breached", () => {
    const t = m.resolve(fresh(), at("2026-09-16T13:30:00Z"));
    expect(status(t, "2026-09-16T13:30:00Z").resolution).toBe("breached");
    expect(status(t, "2026-09-18T12:00:00Z").resolution).toBe("breached");
  });

  it("T11 resolving straight out of a pause credits the wait first", () => {
    // Paused at 12:00 with an hour left, resolved at 15:00 without a reply.
    // Judged against the uncredited 13:00 it would be late; it was not.
    const t = m.resolve(m.pause(fresh(), at("2026-09-16T12:00:00Z")), at("2026-09-16T15:00:00Z"));
    expect(t.sla_paused_at).toBeNull();
    expect(t.sla_paused_minutes).toBe(180);
    expect(status(t, "2026-09-16T15:00:00Z").resolution).toBe("met");
  });

  it("T12 a first response while paused decides that clock alone", () => {
    // Stopped at 09:20 with forty minutes in hand and answered at 10:30, after
    // the stored deadline. The seventy minutes of pause before the answer are
    // credited, so the 10:00 deadline becomes 11:10 and the answer is in time.
    const paused = m.pause(m.stamp(created), at("2026-09-16T09:20:00Z"));
    const answered = m.respond(paused, at("2026-09-16T10:30:00Z"));
    expect(answered.first_response_due_at).toEqual(at("2026-09-16T11:10:00Z"));
    const s = status(answered, "2026-09-16T11:00:00Z");
    expect(s.firstResponse).toBe("met");
    expect(s.resolution).toBe("paused");
    // The pause is still open, so nothing is added to the total yet.
    expect(answered.sla_paused_minutes).toBe(0);
  });

  it("T12 I4 a first response while paused is credited only the pause before it", () => {
    // Thirty minutes late when the clock stopped at 10:30, answered at 12:00,
    // resumed at 14:00. Crediting the whole pause at the resume moved the 10:00
    // deadline to 13:30 and turned the answer into `met`. Credited to the
    // answer, it stays late.
    const paused = m.pause(m.stamp(created), at("2026-09-16T10:30:00Z"));
    const answered = m.respond(paused, at("2026-09-16T12:00:00Z"));
    const resumed = m.resume(answered, at("2026-09-16T14:00:00Z"));
    for (const [t, iso] of [
      [answered, "2026-09-16T12:00:00Z"],
      [answered, "2026-09-16T13:59:00Z"],
      [resumed, "2026-09-16T14:00:00Z"],
      [resumed, "2026-09-23T09:00:00Z"],
    ] as const) {
      expect(status(t, iso).firstResponse, iso).toBe("breached");
    }
    // The resolution clock was stopped the whole time and gets all of it.
    expect(resumed.sla_paused_minutes).toBe(210);
    expect(resumed.resolution_due_at).toEqual(at("2026-09-16T16:30:00Z"));
  });

  it("T12 I4 an answer that is in time when recorded stays in time after the resume", () => {
    // Stopped at 09:50 with ten minutes left, answered at 10:30 (after the
    // stored deadline, inside the credited one) and resumed at 12:00. It read
    // `met` when it was recorded and it reads `met` afterwards: the resume
    // does not credit it a second time.
    const paused = m.pause(m.stamp(created), at("2026-09-16T09:50:00Z"));
    const answered = m.respond(paused, at("2026-09-16T10:30:00Z"));
    expect(answered.first_response_due_at).toEqual(at("2026-09-16T10:40:00Z"));
    expect(status(answered, "2026-09-16T10:30:00Z").firstResponse).toBe("met");

    const resumed = m.resume(answered, at("2026-09-16T12:00:00Z"));
    expect(resumed.first_response_due_at).toEqual(at("2026-09-16T10:40:00Z"));
    expect(status(resumed, "2026-09-16T12:00:00Z").firstResponse).toBe("met");
  });

  it("T7 I4 a pause after a late first response does not make it met", () => {
    // Answered at 10:30 against a 10:00 deadline, then waiting on the
    // requester from 11:00 to 13:00. The resume used to move both deadlines,
    // so the first response's moved to 12:00 and the late answer read `met`.
    const answered = m.respond(m.stamp(created), at("2026-09-16T10:30:00Z"));
    expect(status(answered, "2026-09-16T10:30:00Z").firstResponse).toBe("breached");

    const resumed = m.resume(m.pause(answered, at("2026-09-16T11:00:00Z")), at("2026-09-16T13:00:00Z"));
    expect(resumed.first_response_due_at).toEqual(at("2026-09-16T10:00:00Z"));
    expect(status(resumed, "2026-09-16T13:00:00Z").firstResponse).toBe("breached");
    // The resolution clock was running, and is given the two hours.
    expect(resumed.resolution_due_at).toEqual(at("2026-09-16T15:00:00Z"));
  });

  it("T13 D3 gives a reopened clock back the time the ticket spent resolved", () => {
    // D3, decided 2026-09-19. Met at 12:00 with an hour in hand against 13:00,
    // reopened at 14:00. The two hours resolved were the requester's, so the
    // new clock is due at 15:00 with the same hour in hand. It used to go back
    // to 13:00 and read breached on the spot.
    const t = m.reopen(m.resolve(fresh(), at("2026-09-16T12:00:00Z")), created, at("2026-09-16T14:00:00Z"));
    expect(t.resolved_at).toBeNull();
    expect(t.sla_resolved_minutes).toBe(120);
    expect(t.resolution_due_at).toEqual(at("2026-09-16T15:00:00Z"));
    // The warning moves with it: 12:12 then, 14:12 now.
    expect(t.resolution_warn_at).toEqual(at("2026-09-16T14:12:00Z"));
    expect(status(t, "2026-09-16T14:00:00Z").resolution).toBe("on_track");
    expect(status(t, "2026-09-16T14:00:00Z").minutesToNearest).toBe(60);
    expect(t.resolution_clock_breached).toBeFalsy();
    expect(t.resolution_breached_at).toBeFalsy();
    // The first response was answered at 09:30 and is not touched.
    expect(t.first_response_due_at).toEqual(fresh().first_response_due_at);
  });

  it("T13 I5 D3 the time resolved is carried through a later restamp", () => {
    // A retriage after the reopen stamps from `created_at` again, and has to
    // keep the credit, or it would hand the two hours back to the desk's
    // account the way a retriage once handed back pause time.
    const t = m.reopen(m.resolve(fresh(), at("2026-09-16T12:00:00Z")), created, at("2026-09-16T14:00:00Z"));
    const again = computeSla(created, "P3", settings, t.sla_paused_minutes, t.sla_resolved_minutes);
    expect(again.resolutionDueAt).toEqual(t.resolution_due_at);
    expect(again.resolutionWarnAt).toEqual(t.resolution_warn_at);
    // The first response is not credited for time spent resolved.
    expect(again.firstResponseDueAt).toEqual(computeSla(created, "P3", settings).firstResponseDueAt);
  });

  it("T14 I5 a restamp carries the pause credit already given back", () => {
    // What a retriage does: stamp again from created_at. Without the credit
    // the deadline moved 90 minutes earlier while `sla_paused_minutes` still
    // said 90 had been credited — the row contradicting itself.
    const resumed = m.resume(m.pause(fresh(), at("2026-09-16T10:00:00Z")), at("2026-09-16T11:30:00Z"));
    const restamped = m.stamp(created, resumed.sla_paused_minutes);
    expect(restamped.resolution_due_at).toEqual(resumed.resolution_due_at);
    expect(restamped.resolution_warn_at).toEqual(resumed.resolution_warn_at);
    // The first response settled at 09:30, before the pause, so it is not a
    // running clock and I5 does not describe it. It kept its deadline through
    // the pause, and a restamp keeps it too (`SETTLED_CLOCKS`).
    expect(resumed.first_response_due_at).toEqual(fresh().first_response_due_at);
    expect(m.stamp(created, 0)).toEqual(m.stamp(created));
  });

  // -------------------------------------------------------------------------
  // D1: a breach is a recorded result. T17 and I9 in docs/sla.md.
  // -------------------------------------------------------------------------

  it("T17 I9 a breach is recorded once, at the deadline it missed", () => {
    // Resolution due 13:00. At 13:05 the clock shows a breach nobody has
    // recorded; once it is recorded, every later evaluation finds nothing new.
    const late = fresh();
    expect(unrecordedBreaches(late, at("2026-09-16T12:59:00Z"))).toEqual([]);
    expect(unrecordedBreaches(late, at("2026-09-16T13:05:00Z"))).toEqual([
      { clock: "resolution", breachedAt: at("2026-09-16T13:00:00Z") },
    ]);

    const recorded = m.record(late, at("2026-09-16T13:05:00Z"));
    expect(recorded.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));
    expect(recorded.resolution_clock_breached).toBe(true);
    for (const iso of ["2026-09-16T13:05:00Z", "2026-09-16T14:00:00Z", "2026-09-23T09:00:00Z"]) {
      expect(unrecordedBreaches(recorded, at(iso)), iso).toEqual([]);
      expect(m.record(recorded, at(iso)), iso).toEqual(recorded);
    }
  });

  it("T17 a late answer or resolution is recorded by the write that records it", () => {
    // Answered at 10:30 against 10:00, resolved at 13:30 against 13:00.
    const answered = m.respond(m.stamp(created), at("2026-09-16T10:30:00Z"));
    expect(answered.first_response_breached_at).toEqual(at("2026-09-16T10:00:00Z"));
    const resolved = m.resolve(fresh(), at("2026-09-16T13:30:00Z"));
    expect(resolved.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));

    // Twenty seconds late is too little for the running clock to read
    // `breached`, and enough for the outcome to. The write that records the
    // answer records the breach after it.
    const barely = m.stamp(created);
    expect(unrecordedBreaches(barely, at("2026-09-16T10:00:20Z"))).toEqual([]);
    const justLate = m.respond(barely, at("2026-09-16T10:00:20Z"));
    expect(justLate.first_response_breached_at).toEqual(at("2026-09-16T10:00:00Z"));
  });

  it("T5 T6 T17 a pause records a breach from before it, and none from during it", () => {
    // Thirty minutes late when it stops at 13:30: recorded as the pause begins.
    const lateThenPaused = m.pause(fresh(), at("2026-09-16T13:30:00Z"));
    expect(lateThenPaused.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));

    // Stopped at 12:00 with an hour in hand, and the 13:00 deadline passes
    // while the requester holds it. Nothing to record, then or after.
    const pausedInTime = m.pause(fresh(), at("2026-09-16T12:00:00Z"));
    expect(unrecordedBreaches(pausedInTime, at("2026-09-16T18:00:00Z"))).toEqual([]);
    const resumed = m.resume(pausedInTime, at("2026-09-16T18:00:00Z"));
    expect(resumed.resolution_breached_at).toBeUndefined();
    expect(status(resumed, "2026-09-16T18:00:00Z").resolution).toBe("on_track");
  });

  it("I9 a recorded breach reads breached, whatever the deadline or the outcome says", () => {
    const recorded: Clocks = {
      ...m.stamp(created),
      first_response_breached_at: at("2026-09-16T09:00:00Z"),
      resolution_breached_at: at("2026-09-16T09:00:00Z"),
      resolution_clock_breached: true,
    };
    // A deadline still ahead.
    expect(status(recorded, "2026-09-16T09:30:00Z")).toMatchObject({
      firstResponse: "breached",
      resolution: "breached",
    });
    // An outcome before the deadline.
    const settled = {
      ...recorded,
      first_response_at: at("2026-09-16T09:30:00Z"),
      resolved_at: at("2026-09-16T09:40:00Z"),
    };
    expect(status(settled, "2026-09-16T10:00:00Z")).toMatchObject({
      firstResponse: "breached",
      resolution: "breached",
    });
    // A stopped clock: breached outranks paused (I3).
    const paused = { ...recorded, sla_paused_at: at("2026-09-16T09:30:00Z") };
    expect(status(paused, "2026-09-16T12:00:00Z").resolution).toBe("breached");
  });

  it("T15 I9 a downgrade after the breach cannot turn a late answer into met", () => {
    // First response due 10:00 at P3, recorded as breached at 10:05. Re-marked
    // P4 at 10:30, whose window would put it at 17:00, and answered at 11:00.
    const breached = m.record(m.stamp(created), at("2026-09-16T10:05:00Z"));
    const p4 = m.reclassify(breached, created, "P4", at("2026-09-16T10:30:00Z"));
    expect(p4.first_response_due_at).toEqual(at("2026-09-16T10:00:00Z"));
    expect(status(p4, "2026-09-16T10:30:00Z").firstResponse).toBe("breached");
    // The resolution clock was running and on track, so it takes the P4 stamp.
    expect(p4.resolution_due_at).toEqual(computeSla(created, "P4", settings).resolutionDueAt);

    const answered = m.respond(p4, at("2026-09-16T11:00:00Z"));
    expect(status(answered, "2026-09-16T11:00:00Z").firstResponse).toBe("breached");
    expect(answered.first_response_breached_at).toEqual(at("2026-09-16T10:00:00Z"));

    // What the same answer read before D1: the P4 deadline, and `met`.
    const unrecorded = {
      ...answered,
      first_response_breached_at: null,
      first_response_due_at: at("2026-09-16T17:00:00Z"),
    };
    expect(status(unrecorded, "2026-09-16T11:00:00Z").firstResponse).toBe("met");
  });

  it("T15 I9 a downgrade records a breach nobody had recorded before it restamps", () => {
    // No sweep ran and no other write came between the deadline and the
    // change. The change is the first write to see the breach, so it records
    // it first, and the breached clock then keeps the deadline it missed.
    const p4 = m.reclassify(m.stamp(created), created, "P4", at("2026-09-16T10:30:00Z"));
    expect(p4.first_response_breached_at).toEqual(at("2026-09-16T10:00:00Z"));
    expect(p4.first_response_due_at).toEqual(at("2026-09-16T10:00:00Z"));
  });

  it("T15 I9 an upgrade after the breach keeps the deadline it missed", () => {
    // P1's fifteen minutes would put the first response at 09:15, and make a
    // clock that was thirty minutes late read an hour and a quarter late.
    const p1 = m.reclassify(m.stamp(created), created, "P1", at("2026-09-16T10:30:00Z"));
    expect(p1.first_response_breached_at).toEqual(at("2026-09-16T10:00:00Z"));
    expect(p1.first_response_due_at).toEqual(at("2026-09-16T10:00:00Z"));
    expect(status(p1, "2026-09-16T10:30:00Z").minutesToNearest).toBe(-30);
  });

  it("T15 T17 an upgrade onto a deadline already gone is recorded at that deadline", () => {
    // On track at P3 at 09:20. Re-marked P1, the ticket was always P1 (D2), so
    // its first response was due at 09:15, and that is the breach recorded.
    const p1 = m.reclassify(m.stamp(created), created, "P1", at("2026-09-16T09:20:00Z"));
    expect(p1.first_response_due_at).toEqual(at("2026-09-16T09:15:00Z"));
    expect(p1.first_response_breached_at).toEqual(at("2026-09-16T09:15:00Z"));
  });

  it("T12 I8 a first response on a clock whose breach is recorded is credited nothing", () => {
    // A breached clock that a resume moved (T8) can sit with its deadline
    // ahead of a later pause. The recorded breach still counts as having
    // stopped late, so the answer is not credited onto a `met`.
    const clocks = {
      first_response_due_at: at("2026-09-16T10:00:00Z"),
      first_response_warn_at: at("2026-09-16T09:48:00Z"),
    };
    const pausedAt = at("2026-09-16T09:40:00Z");
    const answeredAt = at("2026-09-16T11:00:00Z");

    const recorded = shiftForFirstResponse(
      { ...clocks, first_response_breached_at: at("2026-09-16T09:30:00Z") },
      pausedAt,
      answeredAt,
      "P3",
      settings,
    );
    expect(recorded.creditMinutes).toBe(0);
    expect(recorded.dueAt).toEqual(clocks.first_response_due_at);

    // The same clock with nothing recorded stopped with twenty minutes in hand.
    const unrecorded = shiftForFirstResponse(clocks, pausedAt, answeredAt, "P3", settings);
    expect(unrecorded.creditMinutes).toBe(80);
  });

  it("T13 I9 a reopen starts a new resolution clock and leaves the old breach where it was", () => {
    // Resolved at 13:30 against 13:00, so the clock records a breach.
    // Re-marked P4 while resolved: the settled clock keeps its deadline. The
    // reopen at 15:00 stamps a new clock for P4, three days long, credited the
    // ninety minutes the ticket spent resolved (D3).
    const resolved = m.resolve(fresh(), at("2026-09-16T13:30:00Z"));
    const relabelled = m.reclassify(resolved, created, "P4", at("2026-09-16T14:00:00Z"));
    expect(relabelled.resolution_due_at).toEqual(at("2026-09-16T13:00:00Z"));

    const p4 = computeSla(created, "P4", settings, 0, 90);
    const reopened = m.reopen(relabelled, created, at("2026-09-16T15:00:00Z"), "P4");
    expect(reopened.resolution_due_at).toEqual(p4.resolutionDueAt);
    expect(reopened.resolution_warn_at).toEqual(p4.resolutionWarnAt);
    // The old clock's breach is history.
    expect(reopened.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));
    // The new clock is running, and is judged on its own deadline.
    expect(reopened.resolution_clock_breached).toBe(false);
    expect(status(reopened, "2026-09-16T15:00:00Z").resolution).toBe("on_track");

    // When the new clock breaches, it records its own breach. The first breach
    // of the target stays the first.
    const later = new Date(p4.resolutionDueAt.getTime() + 5 * 60_000);
    expect(unrecordedBreaches(reopened, later)).toEqual([
      { clock: "resolution", breachedAt: p4.resolutionDueAt },
    ]);
    const again = m.record(reopened, later);
    expect(again.resolution_clock_breached).toBe(true);
    expect(again.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));
  });

  it("T13 I9 D3 a reopen keeps the margin the clock had when it was resolved", () => {
    // Resolved in time at 12:00 and reopened at 14:00. Before D3 this recorded
    // a breach at 13:00, an hour the ticket spent resolved, and D1 made it
    // permanent. The new clock now has the hour it had in hand, and nothing is
    // recorded.
    const met = m.reopen(m.resolve(fresh(), at("2026-09-16T12:00:00Z")), created, at("2026-09-16T14:00:00Z"));
    expect(met.resolution_clock_breached).toBeFalsy();
    expect(met.resolution_breached_at).toBeFalsy();

    // Resolved half an hour late at 13:30, reopened at 15:00. The ninety
    // minutes resolved move the deadline to 14:30, so the new clock starts
    // exactly as late as the old one ended, and records its own breach there.
    // The target's first breach, at 13:00, stays the first.
    const late = m.reopen(m.resolve(fresh(), at("2026-09-16T13:30:00Z")), created, at("2026-09-16T15:00:00Z"));
    expect(late.resolution_due_at).toEqual(at("2026-09-16T14:30:00Z"));
    expect(late.resolution_clock_breached).toBe(true);
    expect(late.resolution_breached_at).toEqual(at("2026-09-16T13:00:00Z"));
    expect(status(late, "2026-09-16T15:00:00Z").minutesToNearest).toBe(-30);
  });
});

describe("the SLA state machine on a business-hours clock", () => {
  const settings = BusinessSettings.parse({
    business_hours: LONDON,
    sla: {
      first_response_minutes: { P1: 15, P2: 60, P3: 240, P4: 480 },
      resolution_minutes: { P1: 240, P2: 480, P3: 1440, P4: 4320 },
      calendar_priorities: ["P1"],
    },
    notifications: { sla_warning_at_percent: 20 },
  });
  const m = machine(settings, "P3");

  it("T14 I5 a restamp after several cycles lands where the cycles left the clock", () => {
    // Wednesday 09:00 London, three pauses, one of them across the evening.
    const created = at("2026-09-16T08:00:00Z");
    let t: Clocks = { ...m.stamp(created), first_response_at: at("2026-09-16T08:30:00Z") };
    const cycles: [string, string][] = [
      ["2026-09-16T09:00:00Z", "2026-09-16T10:30:00Z"],
      ["2026-09-16T15:00:00Z", "2026-09-17T09:15:00Z"],
      ["2026-09-18T11:00:00Z", "2026-09-18T11:20:00Z"],
    ];
    for (const [p, r] of cycles) t = m.resume(m.pause(t, at(p)), at(r));

    const restamped = m.stamp(created, t.sla_paused_minutes);
    expect(wall(restamped.resolution_due_at!)).toBe(wall(t.resolution_due_at!));
    expect(wall(restamped.resolution_warn_at!)).toBe(wall(t.resolution_warn_at!));
  });

  it("T13 D3 credits a weekend spent resolved in working minutes", () => {
    // Wednesday 09:00 London. P3's 1440 working minutes put the resolution
    // due on Friday at 16:00. Resolved on Friday at 15:00, an hour in hand, and
    // reopened on Monday at 10:00. The clock was stopped for Friday's last two
    // and a half working hours and Monday's first, 210 working minutes, and
    // not for the weekend, which it would not have spent anyway.
    const created = at("2026-09-16T08:00:00Z");
    const answered: Clocks = { ...m.stamp(created), first_response_at: at("2026-09-16T08:30:00Z") };
    expect(wall(answered.resolution_due_at!)).toBe("2026-09-18 16:00");

    const reopened = m.reopen(
      m.resolve(answered, at("2026-09-18T14:00:00Z")),
      created,
      at("2026-09-21T09:00:00Z"),
    );
    expect(reopened.sla_resolved_minutes).toBe(210);
    expect(wall(reopened.resolution_due_at!)).toBe("2026-09-21 11:00");

    // The same reading on Monday at 10:00 as on Friday at 15:00: due soon,
    // with the same hour to go.
    const onFriday = slaStatus(answered, at("2026-09-18T14:00:00Z"));
    const onMonday = slaStatus(reopened, at("2026-09-21T09:00:00Z"));
    expect(onMonday.resolution).toBe(onFriday.resolution);
    expect(onMonday.resolution).toBe("due_soon");
    expect(onMonday.minutesToNearest).toBe(onFriday.minutesToNearest);
  });

  it("I2 a breach reported before a pause is reported again after any resume", () => {
    // Due Wednesday 14:00 London. Pauses that begin after it — in the working
    // day, just after closing, overnight, on the Saturday — and resumes from an
    // hour later to the following Monday. At the resume instant and after it,
    // the ticket is breached. The instant itself used to be the exception for
    // a deadline that lands on it (the T8 test below); the breach recorded as
    // the pause began now covers it.
    const due = at("2026-09-16T13:00:00Z");
    const base: Clocks = {
      first_response_at: at("2026-09-16T08:30:00Z"),
      resolved_at: null,
      first_response_due_at: null,
      first_response_warn_at: null,
      resolution_due_at: due,
      resolution_warn_at: at("2026-09-16T10:00:00Z"),
      sla_paused_at: null,
      sla_paused_minutes: 0,
    };
    const pauses = [
      "2026-09-16T13:30:00Z",
      "2026-09-16T16:45:00Z",
      "2026-09-16T22:00:00Z",
      "2026-09-19T11:00:00Z",
    ];
    const resumeAfterHours = [1, 15, 26, 90];

    for (const p of pauses) {
      expect(slaStatus(base, at(p)).resolution, p).toBe("breached");
      for (const h of resumeAfterHours) {
        const r = new Date(at(p).getTime() + h * 3_600_000);
        const t = m.resume(m.pause(base, at(p)), r);
        const oneMinuteLater = new Date(r.getTime() + 60_000);
        expect(slaStatus(t, r).resolution, `${p} +${h}h`).toBe("breached");
        expect(slaStatus(t, oneMinuteLater).resolution, `${p} +${h}h`).toBe("breached");
        expect(t.resolution_breached_at, `${p} +${h}h`).toEqual(due);
      }
    }
  });

  it("T12 I4 a first response keeps the result it was recorded with, whatever the pause does", () => {
    // First response due Wednesday 13:00 London (P3, four working hours from
    // 09:00). Pauses that begin before the deadline and after it, answers
    // during each pause, resumes from an hour to four days later. The answer
    // reads the same at the moment it is recorded, one minute after the
    // resume, and a week on — and it is `breached` exactly when the clock had
    // breached before it stopped.
    const created = at("2026-09-16T08:00:00Z");
    const pauses = [
      "2026-09-16T09:00:00Z",
      "2026-09-16T11:59:00Z",
      "2026-09-16T12:30:00Z",
      "2026-09-16T16:45:00Z",
      "2026-09-19T11:00:00Z",
    ];
    const answerAfterHours = [0.5, 3, 20, 49];
    const resumeAfterAnswerHours = [1, 26, 96];

    for (const p of pauses) {
      const paused = m.pause(m.stamp(created), at(p));
      const stoppedLate = slaStatus(paused, at(p)).firstResponse === "breached";
      for (const a of answerAfterHours) {
        const answeredAt = new Date(at(p).getTime() + a * 3_600_000);
        const answered = m.respond(paused, answeredAt);
        const recorded = slaStatus(answered, answeredAt).firstResponse;
        expect(recorded, `${p} +${a}h`).toBe(stoppedLate ? "breached" : "met");

        for (const r of resumeAfterAnswerHours) {
          const resumedAt = new Date(answeredAt.getTime() + r * 3_600_000);
          const resumed = m.resume(answered, resumedAt);
          const label = `${p} +${a}h, resumed +${r}h`;
          expect(resumed.first_response_due_at, label).toEqual(answered.first_response_due_at);
          expect(slaStatus(resumed, new Date(resumedAt.getTime() + 60_000)).firstResponse, label).toBe(recorded);
          expect(slaStatus(resumed, new Date(resumedAt.getTime() + 7 * 86_400_000)).firstResponse, label).toBe(recorded);
        }
      }
    }
  });

  it("T12 a first response late only in the hours after closing stays late", () => {
    // Due at Friday's close and paused at 18:00: late by the calendar, by no
    // working minutes. Crediting the pause would put the deadline on Monday's
    // answer itself (the T8 exception below) and record `met` against a
    // breach the console had reported all weekend. The clock stopped late, so
    // it keeps its deadline.
    const t: Clocks = {
      first_response_at: null,
      resolved_at: null,
      first_response_due_at: at("2026-09-18T16:30:00Z"),
      first_response_warn_at: at("2026-09-18T15:42:00Z"),
      resolution_due_at: at("2026-09-22T16:30:00Z"),
      resolution_warn_at: at("2026-09-21T11:42:00Z"),
      sla_paused_at: null,
      sla_paused_minutes: 0,
    };
    const paused = m.pause(t, at("2026-09-18T17:00:00Z"));
    expect(slaStatus(paused, at("2026-09-19T12:00:00Z")).firstResponse).toBe("breached");

    const answered = m.respond(paused, at("2026-09-21T08:20:00Z")); // Monday 09:20
    expect(answered.first_response_due_at).toEqual(t.first_response_due_at);
    expect(slaStatus(answered, at("2026-09-21T08:20:00Z")).firstResponse).toBe("breached");
  });

  it("T8 I2 a ticket late only in the hours after closing stays breached through the resume", () => {
    // Due at Friday's close, 17:30, and paused at 18:00: late by the calendar,
    // by no working minutes at all. The resume on Monday gives back the 20
    // working minutes the requester held it, from the next opening, so the
    // deadline lands on the resume instant itself. The business-time lateness
    // is preserved exactly: zero before, zero after.
    //
    // The deadline alone reads `due_soon` for that first minute, and it used
    // to: a breach the console had shown all weekend blinked off on Monday
    // morning. The pause recorded the breach as it began (T17), and the record
    // reads `breached` whatever the deadline says.
    const t: Clocks = {
      first_response_at: at("2026-09-18T08:30:00Z"),
      resolved_at: null,
      first_response_due_at: null,
      first_response_warn_at: null,
      resolution_due_at: at("2026-09-18T16:30:00Z"),
      resolution_warn_at: at("2026-09-18T11:42:00Z"),
      sla_paused_at: null,
      sla_paused_minutes: 0,
    };
    const paused = m.pause(t, at("2026-09-18T17:00:00Z"));
    expect(slaStatus(paused, at("2026-09-19T12:00:00Z")).resolution).toBe("breached");
    expect(paused.resolution_breached_at).toEqual(at("2026-09-18T16:30:00Z"));

    const resumedAt = at("2026-09-21T08:20:00Z"); // Monday 09:20 London
    const after = m.resume(paused, resumedAt);
    expect(after.sla_paused_minutes).toBe(20);
    expect(after.resolution_due_at).toEqual(resumedAt);
    expect(slaStatus(after, resumedAt).resolution).toBe("breached");
    expect(slaStatus(after, at("2026-09-21T08:21:00Z")).resolution).toBe("breached");
    // What the deadline alone says, which is what the console showed before.
    expect(slaStatus({ ...after, resolution_clock_breached: false }, resumedAt).resolution).toBe(
      "due_soon",
    );
    // The breach is the one that happened on Friday, not a new one.
    expect(after.resolution_breached_at).toEqual(at("2026-09-18T16:30:00Z"));
  });
});
