import {
  countTriagedAndLabelled,
  headlineMetrics,
  policyFor,
  reconciledSamples,
  spendByDay,
  volumeByCategory,
} from "@hd/core";
import {
  TAXONOMY,
  attribution,
  scoreRun,
  shadowToScored,
  gateObserved,
  type CalibrationBin,
  type Gate,
  type ThresholdRecommendation,
} from "@hd/eval";
import { currentTenant, pct } from "../../../lib/tenant";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  // `analytics:read` is checked inside each repository call, so an agent
  // account that hand-types the URL gets a 403 page rather than the numbers.
  const tenant = await currentTenant("/analytics");
  const { ctx } = tenant;
  const [metrics, byCategory, shadowRows, outcome, spend] = await Promise.all([
    headlineMetrics(ctx, 30),
    volumeByCategory(ctx, 30),
    reconciledSamples(ctx),
    countTriagedAndLabelled(ctx),
    spendByDay(ctx, 14),
  ]);

  // The console and `npm run eval` score the same rows with the same code, so
  // the number somebody reads here is the number the gate enforces.
  const attr = attribution(shadowRows);
  const report = scoreRun(shadowToScored(shadowRows, { settings: tenant.settings }), {
    source: "shadow",
    taxonomy: TAXONOMY,
    model: attr.model,
    promptVersion: attr.promptVersion,
    neverAuto: tenant.settings.never_auto_categories,
    outcomeCoverage: outcome,
    currentThresholdFor: (category) =>
      policyFor(tenant.settings, category).confidence_threshold,
  });

  const totalSpend = spend.reduce((n, d) => n + Number(d.cost_usd), 0);
  const maxVolume = Math.max(1, ...byCategory.map((c) => c.n));
  const populatedBins = report.calibration.bins.filter((b) => b.n > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <div className="sub">Last 30 days</div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat
          label="Deflection rate"
          value={pct(metrics.deflection_rate, 1)}
          note="closed with no human touch"
        />
        <Stat
          label="Escalation rate"
          value={pct(metrics.escalation_rate, 1)}
          note="handed to a person"
        />
        <Stat
          label="False resolve rate"
          value={pct(metrics.false_resolve_rate, 1)}
          note="agent closed it, the user reopened it"
        />
        <Stat
          label="Calibration error"
          value={
            report.calibration.ece === null
              ? "—"
              : report.calibration.ece.toFixed(3)
          }
          note={`target ≤ 0.05 · n=${report.n}`}
        />
        <Stat
          label="Correction rate"
          value={
            report.category.overall.accuracy === null
              ? "—"
              : pct(1 - report.category.overall.accuracy, 1)
          }
          note="humans reclassified"
        />
        <Stat
          label="False-routing rate"
          value={pct(routingInForce(report).false_routing_rate, 1)}
          note={`${pct(routingInForce(report).coverage, 0)} coverage · ${report.routing.configured ? "configured" : "recommended"} thresholds`}
        />
        <Stat
          label="Model spend"
          value={`$${totalSpend.toFixed(2)}`}
          note="last 14 days"
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>P2 gates</h2>
          <span className="sub">a phase ends when its numbers hold, not when its features exist</span>
        </div>
        {report.n === 0 ? (
          <div className="empty">
            Nothing reconciled yet. Correct or confirm a classification on a
            ticket and these start filling in.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Observed</th>
                <th>Target</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {report.gates.map((g) => (
                <tr key={g.id}>
                  <td>{g.label}</td>
                  <td className="num">{gateObserved(g)}</td>
                  <td className="num">{g.target}</td>
                  <td>
                    <GateBadge status={g.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="panel-body sub">
          An <span className="path">unmeasured</span> gate has not passed. It
          means nothing checked it — most often a safety slice nobody has
          labelled — and reading it as green is how an untested claim becomes a
          shipped one.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Confidence bucket → human correction rate</h2>
          <span className="sub">
            when the agent says 0.9, is it right 90% of the time?
          </span>
        </div>
        {populatedBins.length === 0 ? (
          <div className="empty">
            No ground truth yet. Correct or confirm classifications on tickets
            and this fills in.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Confidence</th>
                <th>Tickets</th>
                <th>Stated</th>
                <th>Actual</th>
                <th>Gap</th>
                <th>Corrected by a human</th>
              </tr>
            </thead>
            <tbody>
              {populatedBins.map((b) => (
                <tr key={b.label}>
                  <td className="path">{b.label}</td>
                  <td className="num">{b.n}</td>
                  <td className="num">{num(b.mean_confidence)}</td>
                  <td className="num">{num(b.accuracy)}</td>
                  <td className="num">
                    <Gap bin={b} minN={report.calibration.min_bin_n} />
                  </td>
                  <td className="num">{pct(b.correction_rate ?? 0, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="panel-body sub">
          A negative gap is overconfidence: the agent claimed more certainty
          than it earned. Buckets under {report.calibration.min_bin_n} tickets
          are shown but do not set the gate — one ticket in a bucket is not a
          calibration finding.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Threshold recommendations</h2>
          <span className="sub">
            measured at 95% accuracy, 95% confidence lower bound
          </span>
        </div>
        {report.thresholds.by_category.length === 0 ? (
          <div className="empty">Nothing reconciled yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>n</th>
                <th>Configured</th>
                <th>Recommended</th>
                <th>Coverage</th>
                <th>Accuracy above</th>
                <th>Autonomy</th>
              </tr>
            </thead>
            <tbody>
              {report.thresholds.by_category.map((t) => (
                <ThresholdRow
                  key={t.scope}
                  rec={t}
                  autonomy={policyFor(tenant.settings, t.scope).autonomy}
                />
              ))}
            </tbody>
          </table>
        )}
        <div className="panel-body sub">
          A recommendation is the <em>lowest</em> threshold whose 95% lower
          bound clears the target — lowest because, among equally defensible
          lines, the one that automates the most tickets wins. Categories
          reading <span className="path">insufficient data</span> have not
          earned a threshold yet, whatever number is configured.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Where automation would send tickets</h2>
          <span className="sub">
            under the {report.routing.policy} thresholds — classification errors,
            converted into work on the wrong desk
          </span>
        </div>
        {report.team.labelled === 0 ? (
          <div className="empty">
            No reconciled ticket has a team on both sides yet.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Threshold</th>
                <th>Tickets</th>
                <th>Auto-routed</th>
                <th>Misrouted</th>
                <th>False-routing</th>
              </tr>
            </thead>
            <tbody>
              {report.routing.by_category.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td className="num">
                    {c.never_auto ? (
                      <span className="chip unmeasured">human only</span>
                    ) : c.threshold === null ? (
                      <span className="path">hold</span>
                    ) : (
                      c.threshold.toFixed(2)
                    )}
                  </td>
                  <td className="num">{c.n}</td>
                  <td className="num">{c.routed}</td>
                  <td className="num">{c.misrouted}</td>
                  <td className="num">
                    {c.false_routing_rate === null ? (
                      "—"
                    ) : c.false_routing_rate > 0.05 ? (
                      <span className="chip fail">{pct(c.false_routing_rate, 1)}</span>
                    ) : (
                      pct(c.false_routing_rate, 1)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="panel-body sub">
          A misclassification that routes to the same team costs nobody an
          afternoon; one that crosses a queue does. This table is the second
          kind. Categories reading <span className="path">hold</span> have no
          defensible threshold, so nothing about them would be automated.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>The one to watch</h2>
        </div>
        <div className="panel-body sub">
          False resolve rate is the failure mode that erodes trust fastest. A
          deflection rate that climbs while this climbs with it is not progress —
          it is the agent closing tickets that were never fixed. Tighten the
          category threshold before widening autonomy anywhere else.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Volume by category</h2>
          <span className="sub">where the automation budget should go</span>
        </div>
        <div className="panel-body">
          {byCategory.length === 0 ? (
            <div className="sub">No triaged tickets yet.</div>
          ) : (
            byCategory.map((c) => (
              <div className="bar-row" key={c.category ?? "untriaged"}>
                <span>{c.category ?? "untriaged"}</span>
                <span className="bar">
                  <i style={{ width: `${(c.n / maxVolume) * 100}%` }} />
                </span>
                <span className="num">{c.n}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {report.category.confusions.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Where the agent is wrong</h2>
            <span className="sub">human label → agent label</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Human said</th>
                <th>Agent said</th>
                <th>Tickets</th>
              </tr>
            </thead>
            <tbody>
              {report.category.confusions.slice(0, 8).map((c) => (
                <tr key={`${c.actual}-${c.predicted}`}>
                  <td>{c.actual}</td>
                  <td className="path">{c.predicted}</td>
                  <td className="num">{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ThresholdRow({
  rec,
  autonomy,
}: {
  rec: ThresholdRecommendation;
  autonomy: string;
}) {
  const configured =
    rec.current_threshold === null ? "—" : rec.current_threshold.toFixed(2);

  return (
    <tr>
      <td>{rec.scope}</td>
      <td className="num">{rec.n}</td>
      <td className="num">
        {rec.verdict === "human_only" ? "—" : configured}
        {rec.current_holds === false && (
          <>
            {" "}
            <span className="chip fail">not justified</span>
          </>
        )}
      </td>
      <td className="num">
        {rec.verdict === "recommended" && rec.recommended ? (
          rec.recommended.threshold.toFixed(2)
        ) : rec.verdict === "human_only" ? (
          <span className="chip unmeasured">human only</span>
        ) : rec.verdict === "insufficient_data" ? (
          <span className="path">insufficient data</span>
        ) : (
          <span className="chip fail">unreachable</span>
        )}
      </td>
      <td className="num">
        {rec.recommended ? pct(rec.recommended.coverage, 0) : "—"}
      </td>
      <td className="num">
        {rec.recommended ? pct(rec.recommended.accuracy ?? 0, 1) : "—"}
      </td>
      <td>
        <span className="path">{autonomy}</span>
      </td>
    </tr>
  );
}

function GateBadge({ status }: { status: Gate["status"] }) {
  if (status === "pass") return <span className="chip pass">pass</span>;
  if (status === "fail") return <span className="chip fail">fail</span>;
  return <span className="chip unmeasured">unmeasured</span>;
}

function Gap({ bin, minN }: { bin: CalibrationBin; minN: number }) {
  if (bin.gap === null) return <span className="sub">—</span>;
  const thin = bin.n < minN;
  const bad = Math.abs(bin.gap) > 0.05;
  const text = `${bin.gap > 0 ? "+" : ""}${bin.gap.toFixed(3)}`;
  if (thin) return <span className="sub">{text}</span>;
  return bad ? <span className="chip fail">{text}</span> : <span>{text}</span>;
}

function num(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

/**
 * The routing outcome under the policy actually in force. A tenant with
 * configured thresholds is running those, not the ones the data would support.
 */
function routingInForce(report: ReturnType<typeof scoreRun>) {
  return report.routing.configured ?? report.routing.recommended;
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}
