import { NextResponse } from "next/server";
import { checkHealth, isReady } from "@hd/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /readyz` — should this instance receive traffic?
 *
 * Deliberately narrower than `/healthz`, because the two are read by different
 * things and conflating them is how a deployment takes itself offline.
 *
 * A load balancer asks this one. It should remove an instance that cannot reach
 * its database, and it must *not* remove one that merely has no mail transport
 * configured or no model key — those are deliberate states, the console works
 * fine in them, and draining every instance because a deployment is in shadow
 * mode would be a self-inflicted outage.
 *
 * So: the fatal dependencies only, and a body small enough that nothing is
 * tempted to parse it for detail.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await checkHealth();
    const ready = isReady(report);
    return NextResponse.json(
      { ready, status: report.status },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[readyz] check failed", err);
    return NextResponse.json(
      { ready: false, status: "down" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
