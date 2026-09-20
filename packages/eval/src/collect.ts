import {
  routeQueue,
  TicketCategory,
  type BusinessSettings,
  type ExportableSample,
  type ReconciledSample,
} from "@hd/core";
import { GoldenSample, assignSplit } from "./sample.js";
import type { ScoredSample } from "./report.js";

/**
 * The bridge from `triage_shadow` to the scorer.
 *
 * Shadow mode has been recording agent-vs-human pairs on every ticket since
 * phase 2 into a table nothing consumed. These two functions are the whole of
 * "consume the existing records": one turns rows into something scoreable, the
 * other freezes rows into a golden file.
 */

/** The classifier's label space, for coverage reporting. */
export const TAXONOMY: readonly string[] = TicketCategory.options;

/**
 * Pass the tenant's settings to score team routing as well.
 *
 * Both teams are derived by running the same routing table over the two
 * classifications, which is what makes the false-routing rate read as "how
 * classification errors turn into tickets on the wrong desk" rather than as a
 * second, independently-wrong prediction.
 */
export function shadowToScored(
  rows: readonly ReconciledSample[],
  opts: { settings?: BusinessSettings } = {},
): ScoredSample[] {
  const settings = opts.settings;
  return rows.map((r) => ({
    id: r.ticket_id,
    predicted: {
      category: r.agent_category,
      priority: r.agent_priority,
      confidence: Number(r.agent_confidence),
      team: settings ? routeQueue(r.agent_category, r.agent_priority, settings) : null,
      is_security_sensitive: r.agent_security_sensitive,
      is_destructive_request: r.agent_destructive,
    },
    actual: {
      category: r.human_category,
      priority: r.human_priority,
      team: settings ? routeQueue(r.human_category, r.human_priority, settings) : null,
      path: r.human_path,
      is_security_sensitive: r.human_security_sensitive,
      is_destructive_request: r.human_destructive,
    },
  }));
}

/**
 * The model and prompt behind a set of rows, when there is exactly one of each.
 *
 * A mixed set is reported as `null` rather than as the most common value: a
 * baseline labelled with a model that produced 60% of the rows is a baseline
 * that will be compared against the wrong thing later.
 */
export function attribution(rows: readonly ReconciledSample[]): {
  model: string | null;
  promptVersion: string | null;
  mixed: boolean;
} {
  const models = new Set(rows.map((r) => r.agent_model).filter((m): m is string => !!m));
  const prompts = new Set(
    rows.map((r) => r.agent_prompt_version).filter((p): p is string => !!p),
  );
  return {
    model: models.size === 1 ? [...models][0]! : null,
    promptVersion: prompts.size === 1 ? [...prompts][0]! : null,
    mixed: models.size > 1 || prompts.size > 1,
  };
}

/**
 * Freeze exportable rows into golden samples.
 *
 * `prompt_vars` is present only for tickets triaged after capture shipped.
 * Older rows get their context rebuilt from current data and are marked
 * `reconstructed`, so a replay difference on those samples can be read as
 * "the context moved" rather than mistaken for a prompt regression.
 */
export function toGoldenSamples(
  rows: readonly ExportableSample[],
  opts: { holdoutPct?: number; settings?: BusinessSettings; labelVersion?: string } = {},
): GoldenSample[] {
  return rows.map((r) => {
    const vars = r.prompt_vars ?? null;
    const attachments = Array.isArray(r.attachments)
      ? (r.attachments as Array<{ filename?: string }>)
          .map((a) => a?.filename ?? "")
          .filter(Boolean)
      : [];

    const sample: GoldenSample = GoldenSample.parse({
      id: r.ticket_id,
      business_id: r.business_id,
      created_at: new Date(r.reconciled_at).toISOString(),
      split: assignSplit(r.ticket_id, opts.holdoutPct ?? 30),
      // Exports arrive as candidates. A console correction is evidence that
      // somebody disagreed with the agent under time pressure, not a reviewed
      // label, and a golden set built by trusting all of them measures
      // agreement with a busy colleague.
      status: "candidate",
      labeler: null,
      reviewed_at: null,
      label_version: opts.labelVersion ?? "v1",
      // Every row here has a human label; whether the human changed the
      // agent's answer or confirmed it is the difference between the two.
      label_source:
        r.human_category === r.agent_category && r.human_priority === r.agent_priority
          ? "human_confirmation"
          : "human_correction",
      input: {
        source: r.source,
        subject: r.subject,
        body: r.body,
        attachments,
        requester_line: vars?.requester_line ?? reconstructRequesterLine(r),
        vip: vars ? vars.vip === "true" : (r.requester_vip ?? false),
        device_line: vars?.device_line ?? "",
        recent_tickets: vars?.recent_tickets ?? "",
        active_incidents: vars?.active_incidents ?? "",
        business_name: vars?.business_name ?? r.business_name,
        business_type: vars?.business_type ?? r.business_type,
        fidelity: vars ? "captured" : "reconstructed",
      },
      label: {
        category: r.human_category,
        priority: r.human_priority,
        team: opts.settings
          ? routeQueue(r.human_category, r.human_priority, opts.settings)
          : null,
        path: r.human_path,
        is_security_sensitive: r.human_security_sensitive,
        is_destructive_request: r.human_destructive,
      },
      recorded: {
        category: r.agent_category,
        priority: r.agent_priority,
        confidence: Number(r.agent_confidence),
        path: r.agent_path,
        is_security_sensitive: r.agent_security_sensitive,
        is_destructive_request: r.agent_destructive,
        model: r.agent_model,
        prompt_version: r.agent_prompt_version,
        recorded_at: new Date(r.recorded_at).toISOString(),
      },
      note: null,
    });
    return sample;
  });
}

/** Mirrors `requesterLine` in the agent package, from the exported columns. */
function reconstructRequesterLine(r: ExportableSample): string {
  if (!r.requester_email) return "Unknown sender (not in the directory)";
  const name = r.requester_name ?? r.requester_email;
  const role = [r.requester_department, r.requester_role].filter(Boolean).join(", ");
  return role ? `${name} — ${role}` : name;
}

/** Score a golden file against the predictions recorded in it. */
export function goldenToScored(
  samples: readonly GoldenSample[],
  opts: { settings?: BusinessSettings } = {},
): ScoredSample[] {
  const out: ScoredSample[] = [];
  for (const s of samples) {
    if (!s.recorded) continue;
    out.push({
      id: s.id,
      predicted: {
        category: s.recorded.category,
        priority: s.recorded.priority,
        confidence: s.recorded.confidence,
        team: opts.settings
          ? routeQueue(s.recorded.category, s.recorded.priority, opts.settings)
          : null,
        is_security_sensitive: s.recorded.is_security_sensitive,
        is_destructive_request: s.recorded.is_destructive_request,
      },
      actual: s.label,
    });
  }
  return out;
}
