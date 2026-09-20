import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { z } from "zod";

// Every entry point (web, worker, scripts) imports core, so loading the root
// .env here means nobody has to remember to do it.
const repoRoot = path.resolve(process.cwd().includes("apps") ? "../.." : ".");
loadDotenv({ path: path.join(repoRoot, ".env"), quiet: true });
loadDotenv({ quiet: true });

/** BullMQ's default key prefix, and so the namespace the worker consumes. */
export const DEFAULT_QUEUE_PREFIX = "bull";

export const AgentMode = z.enum(["shadow", "assist", "auto"]);
export type AgentMode = z.infer<typeof AgentMode>;

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://helpdesk:helpdesk@localhost:5433/helpdesk"),
  REDIS_URL: z.string().default("redis://localhost:6380"),
  /**
   * Redis key namespace for the job queues. The default is BullMQ's own, which
   * is where the worker reads. The test run and the intake benchmark write
   * somewhere else: their tickets are deleted when they finish, and in the
   * worker's namespace a running worker would triage them mid-test — against
   * the real model, if a key is set — and a stopped one would find thousands of
   * jobs for tickets that no longer exist the next time it started.
   */
  QUEUE_PREFIX: z.string().min(1).default(DEFAULT_QUEUE_PREFIX),

  ANTHROPIC_API_KEY: z.string().optional(),
  TRIAGE_MODEL: z.string().default("claude-opus-5"),
  DRAFT_MODEL: z.string().default("claude-opus-5"),
  TRIAGE_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("low"),

  EMBEDDING_PROVIDER: z.enum(["hash", "openai"]).default("hash"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_API_KEY: z.string().optional(),

  AGENT_MODE: AgentMode.default("shadow"),
  LLM_DAILY_COST_CAP_USD: z.coerce.number().positive().default(25),

  INTAKE_WEBHOOK_SECRET: z.string().default("dev-secret-change-me"),
  /**
   * Signs requester portal links and the unsubscribe links in notifications.
   * Separate from the intake secret on purpose, and the two link purposes are
   * domain-separated inside the signature rather than sharing one namespace.
   */
  PORTAL_SECRET: z.string().default("dev-portal-secret-change-me"),
  /**
   * Where the console lives, for links in outbound mail. A notification with
   * no link asks the reader to go and find the ticket themselves.
   */
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  INTAKE_MAILDIR: z.string().default("./db/seed/inbox"),

  /**
   * Outbound mail.
   *
   * `spool` is the development transport: it renders the real message and
   * writes it to a folder, so the whole delivery path — queue, claim, retry,
   * status, history — runs exactly as it does in production and no stranger
   * receives a test email. It is the default for the same reason `hash` is the
   * default embedder: a developer with no credentials should get a working
   * system, not a broken one.
   *
   * `none` records the message and parks it as `cancelled`. It is for a
   * deployment that has deliberately decided not to send, and it is honest
   * about it — nothing accumulates retries waiting for a transport that is
   * never coming.
   */
  OUTBOUND_EMAIL_PROVIDER: z
    .enum(["spool", "smtp", "postmark", "none"])
    .default("spool"),
  /**
   * Fallback From address. A tenant with an `intake_address` sends from that
   * instead, so a reply to our reply arrives back in the same tenant.
   */
  OUTBOUND_FROM_ADDRESS: z.string().default("helpdesk@localhost"),
  OUTBOUND_FROM_NAME: z.string().default("IT Support"),
  /** Right-hand side of the Message-IDs we mint. Must be a domain we own. */
  OUTBOUND_MESSAGE_ID_DOMAIN: z.string().default("helpdesk.local"),
  /** Where the `spool` transport writes. One .eml per message. */
  OUTBOUND_SPOOL_DIR: z.string().default("./db/seed/outbox"),
  /**
   * Attempts before a message becomes a dead letter. Five, with the backoff in
   * `retryDelayMs`, spans a little over two hours — long enough to ride out a
   * provider incident, short enough that somebody still cares when it lands in
   * the failed queue.
   */
  OUTBOUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /** `smtp` transport. A URL, or the parts. */
  SMTP_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** True for implicit TLS on 465; 587 negotiates STARTTLS and stays false. */
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /** `postmark` transport. Server token, not the account token. */
  POSTMARK_SERVER_TOKEN: z.string().optional(),

  /**
   * AES-256-GCM key for integration credentials at rest, hex or base64.
   * Short or absent in development, which `credentialKey()` warns about rather
   * than refusing: a developer without a key should get a working console, and
   * a production deployment without one should get a loud log line.
   */
  CREDENTIALS_KEY: z.string().default(""),
});

export const env = EnvSchema.parse(process.env);

/** The embedding width the schema is built around. Changing it is a migration. */
export const EMBEDDING_DIMS = 1536;
