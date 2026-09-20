import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  checkApiRateLimit,
  contextForApiKey,
  getSettings,
  recordApiRequest,
  type ApiCaller,
} from "@hd/core";

/**
 * The REST API's front door.
 *
 * Everything every endpoint has to get right, in one place: the credential, the
 * tenant, the rate limit, the error shape, and the log line. A route that
 * implements any of those itself will eventually implement one of them
 * differently, and the one that goes wrong quietly is the tenant.
 *
 * The rule is the same as the console's and the intake webhook's, stated once
 * more because this is the third place it matters: **the tenant comes from the
 * credential.** There is no `business_id` parameter anywhere in this API, and
 * nothing in a URL, a query string or a body can influence which tenant a
 * request reads. What the key names is what the request gets.
 */

export interface ApiRequestContext<P = Record<string, never>> {
  caller: ApiCaller;
  request: Request;
  /** Route parameters, awaited. */
  params: P;
  url: URL;
}

export type ApiHandler<P> = (ctx: ApiRequestContext<P>) => Promise<NextResponse>;

/** The one error shape. A client should never have to guess. */
function fail(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Map an exception to a status code.
 *
 * The interesting line is `NotFoundError` → 404 for a resource in another
 * tenant. The data layer produces that deliberately: within a tenant a missing
 * permission is a plain 403, because the resource's existence is not the
 * secret, but across tenants "exists but forbidden" and "does not exist" have
 * to be indistinguishable or the API becomes an id-enumeration oracle.
 */
function errorResponse(err: unknown): NextResponse {
  if (err instanceof InvalidJsonError) {
    return fail(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (err instanceof ZodError) {
    return fail(422, "invalid_request", "The request body or query is not valid.", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof NotFoundError) {
    return fail(404, "not_found", "No such resource.");
  }
  if (err instanceof AuthorizationError) {
    return fail(
      403,
      "forbidden",
      `This key's role does not permit that${err.permission ? ` (${err.permission})` : ""}.`,
    );
  }
  if (err instanceof AuthenticationError) {
    return fail(401, "unauthenticated", "A valid API key is required.");
  }
  // Anything else is ours. The message stays on the server: an unhandled error
  // string is where stack traces and connection strings leak out.
  console.error("[api] unhandled", err);
  return fail(500, "internal_error", "Something went wrong handling that request.");
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  // Accepted as well, because half the tools in an IT department can set a
  // custom header and not an Authorization one.
  return request.headers.get("x-api-key");
}

function clientIp(request: Request): string | null {
  // `||` rather than `??`: an empty `x-forwarded-for` is no address, not "".
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null
  );
}

/**
 * The second argument is required rather than optional, because Next's
 * generated route types declare it that way — `RouteContext` is
 * `{ params: Promise<SegmentParams> }`, and a handler offering
 * `context?: ...` fails `next build` with a type error that never appears in
 * `tsc --noEmit`. A static route still receives one, carrying a promise of an
 * empty object, so the runtime read below tolerates its absence anyway.
 */
export function withApi<P = Record<string, never>>(handler: ApiHandler<P>) {
  return async function route(
    request: Request,
    context: { params: Promise<P> },
  ): Promise<NextResponse> {
    const started = Date.now();
    const url = new URL(request.url);
    const caller = await contextForApiKey(bearer(request));

    if (!caller) {
      // Nothing is logged to `api_requests` here, because there is no tenant to
      // log it against: an unauthenticated request belongs to no business, and
      // filing it under a guess would be worse than not having the row.
      return fail(
        401,
        "unauthenticated",
        "Send an API key as `Authorization: Bearer hd_...`. Keys are created in Settings.",
      );
    }

    const settings = await getSettings(caller.ctx.businessId);
    const rate = await checkApiRateLimit(caller, settings.api_rate_limit_per_minute);

    let response: NextResponse;
    if (!rate.allowed) {
      response = fail(429, "rate_limited", `More than ${rate.limit} requests in a minute.`, {
        retry_after: rate.retryAfter,
      });
      response.headers.set("retry-after", String(rate.retryAfter));
    } else {
      try {
        const params = ((await context?.params) ?? {}) as P;
        response = await handler({ caller, request, params, url });
      } catch (err) {
        response = errorResponse(err);
      }
    }

    response.headers.set("x-ratelimit-limit", String(rate.limit));
    response.headers.set(
      "x-ratelimit-remaining",
      String(Math.max(0, rate.limit - rate.used - 1)),
    );

    // Logged whatever happened, including the refusals: a 403 from an API key is
    // more interesting than a 200, and a log containing only successes cannot
    // show somebody probing.
    await recordApiRequest({
      businessId: caller.ctx.businessId,
      apiKeyId: caller.key.id,
      method: request.method,
      path: url.pathname + (url.search ? url.search : ""),
      status: response.status,
      latencyMs: Date.now() - started,
      ip: clientIp(request),
    }).catch((err) => console.error("[api] could not log request", err));

    return response;
  };
}

class InvalidJsonError extends Error {}

/**
 * The request body, parsed.
 *
 * A body that is not JSON is the client's mistake, so it is a 400 that says
 * so. Calling `request.json()` directly let the parser's `SyntaxError` reach
 * the catch-all, which answered 500 and sent the client looking for an outage.
 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidJsonError();
  }
}

/** The success shape: data, plus whatever a client needs to page. */
export function ok(
  data: unknown,
  meta?: Record<string, unknown>,
  status = 200,
): NextResponse {
  return NextResponse.json(meta ? { data, meta } : { data }, { status });
}

/**
 * A bounded integer from the query string.
 *
 * Bounded rather than validated: a client that asks for 10,000 tickets gets
 * 100 and a `meta.limit` saying so, which is friendlier than a 422 and stops
 * one caller holding a connection open while Postgres sorts their whole table.
 */
export function intParam(
  url: URL,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** `?status=new,triaged` or a repeated `?status=`. Both spellings exist in the wild. */
export function listParam(url: URL, name: string): string[] {
  return url.searchParams
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}
