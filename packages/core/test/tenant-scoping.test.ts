import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural checks on the source, not on its behaviour.
 *
 * The cross-tenant tests in `isolation.test.ts` prove that the queries which
 * exist are scoped. They cannot prove anything about the query somebody adds
 * next Tuesday. These can: they read the tree and assert the shape that makes
 * tenant isolation hold, so a repository function that forgets its context
 * fails in CI on a machine with no database.
 *
 * Everything here is an allowlist rather than a heuristic. When an exception is
 * genuinely needed it goes in the list below with a reason, and adding one is a
 * visible line in a diff that a reviewer has to agree with — which is the only
 * property that makes a check like this worth having.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * Source, normalized to LF.
 *
 * Several files in this repository have CRLF endings, and the signature parser
 * below looks for a brace followed by a newline. On a CRLF file that matches
 * nothing, the "signature" becomes the entire function body, and every check
 * that inspects a signature silently starts reporting what the body contains.
 * Normalizing here is the difference between these tests working and these
 * tests appearing to work.
 */
function read(file: string): string {
  return fs.readFileSync(file, "utf8").split("\r\n").join("\n");
}

/**
 * The same source with comments removed.
 *
 * Every check below looks for a pattern in code. Without this they also match
 * the prose describing what was removed, and a check that fails because
 * somebody documented the bug it prevents is a check people delete.
 *
 * String literals survive, because a literal like "human:console" is exactly
 * what some of these are looking for.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      // Only strips a `//` that begins the line's content, which is how
      // comments are written here. A `//` inside a url or a regex is left
      // alone rather than risking a mangled line.
      const at = line.indexOf("//");
      if (at === -1) return line;
      const before = line.slice(0, at);
      return before.trim() === "" ? before : line;
    })
    .join("\n");
}

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, match, out);
    } else if (match.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(repoRoot, f).replace(/\\/g, "/");

// ---------------------------------------------------------------------------

describe("the constant actor is gone", () => {
  /**
   * The string this whole phase existed to remove. It is not an actor: it
   * cannot be revoked, scoped to a tenant, or asked about afterwards.
   */
  it("no source file writes human:console", () => {
    const files = [
      ...walk(path.join(repoRoot, "packages"), /\.tsx?$/),
      ...walk(path.join(repoRoot, "apps"), /\.tsx?$/),
      ...walk(path.join(repoRoot, "scripts"), /\.ts$/),
    ];
    const offenders = files
      .map(rel)
      // `rel` normalizes separators, so this works on Windows too. The tests
      // under it name the string in order to assert that it is gone.
      .filter((f) => !f.includes("/test/"))
      .filter((f) => code(path.join(repoRoot, f)).includes("human:console"));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * Data-layer functions that legitimately run without a `TenantContext`.
 *
 * Two kinds only:
 *
 *   - Named escape hatches. `*Unscoped` / `*Unaudited` are deliberately ugly so
 *     they are one grep away and obvious in review.
 *   - Pre-authentication helpers. Sign-in, the tenant picker and intake all run
 *     before a context can exist, and each takes an explicit `businessId` it
 *     puts in the predicate.
 */
const CONTEXT_FREE_BY_DESIGN: Record<string, string> = {
  // Escape hatches, named to be obvious.
  getTicketUnscoped: "the worker resolves a ticket's tenant before it has one",
  getRequesterUnscoped: "the portal resolves a requester's tenant from a signed link",
  updateSettingsUnaudited: "migrations and seeds, never reachable from a request",
  purgeBusinessUnaudited: "tenant offboarding and test teardown; lifts the append-only guard for one transaction",
  createUserUnaudited: "seed and CLI; creates the first user of a deployment",
  addMembershipUnaudited: "seed and CLI",

  // Pre-authentication: there is no session yet.
  auditAnonymous: "records sign-in attempts, which by definition have no context",
  listBusinesses: "the tenant picker and sign-in run before a tenant is chosen",
  getBusiness: "looked up by id during intake and sign-in",
  getSettings: "leaf read by id; the permissioned wrapper is readSettings",

  // Intake: the tenant is resolved from the transport, then passed explicitly.
  upsertRequester: "intake, scoped by the business_id argument",
  findRequesterByEmail: "intake and tools, scoped by the business_id argument",
  upsertStaff: "seed and CLI",
  recordMessageId: "intake threading, keyed on a message id",
  findTicketByReferences: "intake threading, scoped by the business_id argument",
  findTicketBySubjectTag: "intake threading, scoped by the business_id argument",

  // Usage accounting is written by the LLM gateway, which has no session.
  recordUsage: "written by the model gateway, which runs below the session",
  spendToday: "the deployment-wide spend cap, deliberately not per-tenant",

  // Scheduled sweeps. These act on every tenant by definition, expire rows on
  // a clock rather than on anyone's instruction, and return a count rather than
  // any tenant's data. Expiry is also re-checked at the point of use, so a
  // sweep that never runs cannot let a stale row through.
  expireConfigRequests: "time-based sweep across tenants; returns only a count",
  expireApprovals: "time-based sweep across tenants; returns ids for the caller to notify",
  dueOutbound: "delivery sweep across tenants; returns ids and attempt counts, never message content",
  reclaimStalledOutbound: "delivery sweep across tenants; returns messages a stopped worker left in flight",

  // The delivery worker's equivalent of `getTicketUnscoped`: it holds a job id
  // and no tenant, and the row it claims is what names the tenant every
  // subsequent write is scoped by. The claim has to be one statement, so it
  // cannot be preceded by a scoped read.
  claimOutbound: "the delivery worker resolves a message's tenant by claiming it",

  // Read by the pipeline, which runs as the agent and holds no `config:read`.
  // Returns an integer and nothing else, so it discloses less than the ticket
  // row it is about to be stamped on.
  currentConfigVersionNumber: "leaf read by id, like getSettings; returns only a version number",

  // Authentication, which is where a context comes from and therefore cannot
  // require one. `contextForApiKey` is the API's equivalent of sign-in: it
  // looks a credential up by hash and *returns* the tenant, and the two
  // functions below take the caller it produced rather than a request
  // parameter, so nothing in a URL or a body can reach them.
  contextForApiKey: "the API's sign-in; resolves a key's tenant by token hash",
  checkApiRateLimit: "counts one key's own rows, keyed on the caller it was handed",
  recordApiRequest: "the request log, written with the tenant the credential named",

  // Process liveness, which is deployment-wide by definition. Scoping a
  // heartbeat to a tenant would mean a health check had to pick a business to
  // ask about, and "is the worker up" is not a question about a business. No
  // tenant's data is reachable through any of them: a row is an id, a clock and
  // a version.
  recordHeartbeat: "process liveness, deployment-wide; written by a worker with no session",
  listHeartbeats: "process liveness, deployment-wide; contains no tenant data",
  latestHeartbeat: "process liveness, read by the health check before any tenant is known",
  clearHeartbeat: "a process removing its own row on a deliberate shutdown",
};

/** Files whose exports are the data layer. */
const DATA_LAYER = [
  ...walk(path.join(repoRoot, "packages", "core", "src", "repos"), /\.ts$/),
  path.join(repoRoot, "packages", "core", "src", "metrics.ts"),
  path.join(repoRoot, "packages", "core", "src", "intake.ts"),
  ...walk(path.join(repoRoot, "packages", "rag", "src"), /\.ts$/),
];

interface ExportedFn {
  file: string;
  name: string;
  signature: string;
  body: string;
}

/** Crude but adequate: these files are hand-written and consistently formatted. */
function exportedFunctions(file: string): ExportedFn[] {
  const src = code(file);
  const out: ExportedFn[] = [];
  const re = /^export (?:async )?function (\w+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const next = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, next === -1 ? src.length : next);
    const bodyStart = body.indexOf("{\n");
    out.push({
      file,
      name: m[1]!,
      signature: bodyStart === -1 ? body : body.slice(0, bodyStart),
      body,
    });
  }
  return out;
}

/**
 * Every function in a file, exported or not.
 *
 * `exportedFunctions` deliberately only sees the public surface, which is right
 * for the data-layer checks. The server-action check needs the private helpers
 * too, because delegating to one is a legitimate shape.
 */
function allFunctions(file: string): ExportedFn[] {
  const src = code(file);
  const out: ExportedFn[] = [];
  const re = /^(?:export )?(?:async )?function (\w+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const next = src.slice(start + 1).search(/^(?:export )?(?:async )?function /m);
    const body = src.slice(start, next === -1 ? src.length : start + 1 + next);
    const bodyStart = body.indexOf("{\n");
    out.push({
      file,
      name: m[1]!,
      signature: bodyStart === -1 ? body : body.slice(0, bodyStart),
      body,
    });
  }
  return out;
}

const RUNS_SQL = /\b(query|queryOne|tx|client\.query)\s*[<(]/;

describe("the data layer requires a tenant context", () => {
  const all = DATA_LAYER.flatMap(exportedFunctions);

  it("found the data layer at all", () => {
    // A path typo would make every assertion below vacuously pass.
    expect(all.length).toBeGreaterThan(40);
  });

  it("every exported function that runs SQL takes one, or is a listed exception", () => {
    const offenders = all
      .filter((fn) => RUNS_SQL.test(fn.body))
      .filter((fn) => !fn.signature.includes("TenantContext"))
      .filter((fn) => !(fn.name in CONTEXT_FREE_BY_DESIGN))
      .map((fn) => `${rel(fn.file)}: ${fn.name}`);

    expect(
      offenders,
      "Add a TenantContext parameter, or list it in CONTEXT_FREE_BY_DESIGN with a reason",
    ).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    // An entry for a function that no longer exists is a comment pretending to
    // be a check.
    const names = new Set(all.map((fn) => fn.name));
    const stale = Object.keys(CONTEXT_FREE_BY_DESIGN).filter((n) => !names.has(n));
    expect(stale, "these exceptions name functions that no longer exist").toEqual([]);
  });

  it("never lets a caller pass a tenant alongside a context", () => {
    // Both would mean the caller gets to choose which one wins, which is the
    // whole bug in a smaller shape.
    const offenders = all
      .filter((fn) => fn.signature.includes("TenantContext"))
      .filter((fn) => /\bbusinessId\s*[:,)]|\bbusiness_id\s*:/.test(fn.signature))
      .map((fn) => `${rel(fn.file)}: ${fn.name}`);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the console cannot be told which tenant to act in", () => {
  const actionFiles = walk(path.join(repoRoot, "apps", "web", "app"), /actions\.ts$/);

  it("found the server actions", () => {
    expect(actionFiles.length).toBeGreaterThan(2);
  });

  it("every exported server action establishes its own identity", () => {
    const offenders: string[] = [];
    for (const file of actionFiles) {
      // Sign-in and tenant selection are the authentication boundary itself;
      // requiring a session in order to create one would be circular.
      if (rel(file).includes("(auth)/actions.ts")) continue;

      // Private helpers count as delegates too. A server action whose whole
      // body is `return apply("category", formData)` is guarded exactly as
      // well as one that calls `requireConsole()` itself, provided `apply`
      // does — and most of these files are shaped that way on purpose.
      const fns = allFunctions(file);
      const guards = (fn: ExportedFn) =>
        /requireConsole|requireConsolePermission/.test(fn.body);
      const guarded = new Set(fns.filter(guards).map((fn) => fn.name));

      for (const fn of exportedFunctions(file)) {
        if (guards(fn)) continue;
        const delegates = [...guarded].some((name) =>
          new RegExp(`\\b${name}\\s*\\(`).test(fn.body),
        );
        if (!delegates) offenders.push(`${rel(file)}: ${fn.name}`);
      }
    }
    expect(
      offenders,
      "every exported server action must reach requireConsole(), directly or through one in the same file",
    ).toEqual([]);
  });

  it("no server action accepts a business id as an argument", () => {
    const offenders: string[] = [];
    for (const file of actionFiles) {
      for (const fn of exportedFunctions(file)) {
        if (/\b(businessId|business_id)\s*[:,)]/.test(fn.signature)) {
          offenders.push(`${rel(file)}: ${fn.name}`);
        }
      }
    }
    expect(
      offenders,
      "the tenant comes from the session, never from the caller",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("pages and components do not write their own SQL", () => {
  /**
   * A hand-written `select` in a React component is scoped correctly right up
   * until somebody copies it into a second page and drops the predicate, and it
   * is invisible to every check in this file. Queries belong in the data layer,
   * where the context parameter is compulsory.
   */
  it("no page or component imports the query helpers", () => {
    const files = walk(path.join(repoRoot, "apps", "web", "app"), /\.tsx?$/);
    const offenders = files
      .filter((f) => {
        const src = code(f);
        const imports = src.match(/import\s*\{[^}]*\}\s*from\s*"@hd\/core"/s)?.[0] ?? "";
        return /\b(query|queryOne|tx)\b/.test(imports);
      })
      .map(rel);

    expect(
      offenders,
      "move the query into packages/core/src/repos and give it a TenantContext",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the tenant is not carried in a cookie", () => {
  /**
   * The specific bug this phase removed: `hd_business` was a cookie the browser
   * could set to any uuid, and every page read it without asking whether the
   * person was allowed to be in that tenant.
   */
  it("no cookie names a business", () => {
    const files = walk(path.join(repoRoot, "apps", "web"), /\.tsx?$/);
    const offenders = files
      .filter((f) => /hd_business|TENANT_COOKIE/.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
