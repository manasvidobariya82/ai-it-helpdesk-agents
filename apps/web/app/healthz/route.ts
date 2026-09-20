import { NextResponse } from "next/server";
import { checkHealth, isReady, publicHealth } from "@hd/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /healthz` — the unauthenticated health endpoint.
 *
 * Three decisions, each of which is the difference between a useful monitor and
 * a decorative one.
 *
 * **It actually checks.** Every dependency is touched: a query, a Redis round
 * trip, the age of the worker's last heartbeat. A 200 from a route that only
 * proves Next.js is running tells you the one thing you already knew, because
 * the request reached it.
 *
 * **It says nothing it does not have to.** `publicHealth` strips detail,
 * versions, queue depths and error text. A health endpoint is reachable by
 * anybody who can reach the service, and "cannot connect to postgres at
 * db-prod-3.internal:5432" is a free map of the deployment.
 *
 * **The status code is the answer.** 200 while requests can be served, 503 when
 * they cannot. Monitors read status codes; a 200 with `{"status":"down"}` in
 * the body is an outage that pages nobody.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await checkHealth();
    return NextResponse.json(publicHealth(report), {
      status: isReady(report) ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    // The health check itself failing is the most severe answer available, and
    // it must still be an answer rather than a stack trace with a 500.
    console.error("[healthz] check failed", err);
    return NextResponse.json(
      { status: "down", checks: [], at: new Date().toISOString() },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
