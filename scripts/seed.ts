import {
  addMembershipUnaudited,
  BusinessSettings,
  closePool,
  createUserUnaudited,
  query,
  queryOne,
  upsertStaff,
  type Role,
} from "@hd/core";

/**
 * Seed a plausible small IT services tenant: a directory, devices, one live
 * incident, and enough resolved history that the analytics page is not empty
 * on first run.
 *
 * Autonomy is seeded OFF for every category on purpose. The phase plan says
 * you earn autonomy from measured accuracy; a seed script that hands it out
 * would be arguing with the plan.
 */

const settings: BusinessSettings = BusinessSettings.parse({
  default_policy: { autonomy: "off", confidence_threshold: 0.95 },
  category_policies: {
    // Realistic starting points, all still off. Phase 4 flips these two first
    // because they are the highest-volume, lowest-risk categories.
    access_identity: { autonomy: "off", confidence_threshold: 0.9 },
    email_collab: { autonomy: "off", confidence_threshold: 0.92 },
    software: { autonomy: "off", confidence_threshold: 0.97 },
    security_incident: { autonomy: "off", confidence_threshold: 0.99 },
  },
  kb_support_floor: 0.62,
  auto_action_whitelist: [],
  max_clarify_rounds: 1,
  followup_hours: 24,
  business_hours_tz: "Europe/London",
  signature: "— Northgate IT Support",
});

const PEOPLE = [
  { email: "priya.shah@northgate.example", name: "Priya Shah", dept: "Finance", role: "Financial Controller", vip: true },
  { email: "tom.reed@northgate.example", name: "Tom Reed", dept: "Sales", role: "Account Executive", vip: false },
  { email: "aisha.khan@northgate.example", name: "Aisha Khan", dept: "Engineering", role: "Senior Developer", vip: false },
  { email: "dan.osei@northgate.example", name: "Dan Osei", dept: "Operations", role: "Warehouse Supervisor", vip: false },
  { email: "mel.hartley@northgate.example", name: "Mel Hartley", dept: "HR", role: "HR Manager", vip: false },
  { email: "greg.lin@northgate.example", name: "Greg Lin", dept: "Executive", role: "Managing Director", vip: true },
];

const DEVICES = [
  { email: "priya.shah@northgate.example", tag: "NG-LT-0114", kind: "laptop", os: "Windows 11 23H2", daysAgo: 0 },
  { email: "tom.reed@northgate.example", tag: "NG-LT-0207", kind: "laptop", os: "Windows 11 23H2", daysAgo: 1 },
  { email: "aisha.khan@northgate.example", tag: "NG-MB-0043", kind: "laptop", os: "macOS 15.2", daysAgo: 0 },
  { email: "dan.osei@northgate.example", tag: "NG-TB-0019", kind: "tablet", os: "Android 14", daysAgo: 12 },
  { email: "mel.hartley@northgate.example", tag: "NG-LT-0188", kind: "laptop", os: "Windows 11 22H2", daysAgo: 3 },
  { email: "greg.lin@northgate.example", tag: "NG-MB-0002", kind: "laptop", os: "macOS 15.2", daysAgo: 0 },
];

/**
 * The IT team the tickets get handed to. `tickets.assigned_to` and the queue's
 * assign menu both point here, and without a row in this table escalation has
 * somewhere to route but nobody to route to.
 *
 * The queue names are the ones the agent actually uses: `ticket.escalate` sends
 * P1 to `oncall` and everything else to `tier1`. `tier2` is here because humans
 * escalate further than the agent can.
 */
const STAFF = [
  { email: "sam.okafor@northgate.example", name: "Sam Okafor", queue: "tier1" },
  { email: "ellie.byrne@northgate.example", name: "Ellie Byrne", queue: "tier1" },
  { email: "raj.patel@northgate.example", name: "Raj Patel", queue: "tier2" },
  { email: "nina.volkov@northgate.example", name: "Nina Volkov", queue: "oncall" },
];

/**
 * Console accounts, one per role.
 *
 * Seeding one of each is deliberate: the fastest way to find out that a page
 * assumed everybody is an admin is to sign in as a viewer and look at it. The
 * password is the same for all of them and printed at the end, because this is
 * a development seed and pretending otherwise would just mean it ends up in a
 * README instead.
 */
const CONSOLE_USERS: { email: string; name: string; role: Role }[] = [
  { email: "admin@northgate.example", name: "Ops Admin", role: "admin" },
  { email: "security@northgate.example", name: "Sec Admin", role: "security_admin" },
  { email: "manager@northgate.example", name: "Queue Manager", role: "manager" },
  { email: "agent@northgate.example", name: "Service Desk Agent", role: "agent" },
  { email: "viewer@northgate.example", name: "Read Only", role: "viewer" },
];

const SEED_PASSWORD = "northgate-dev-password";

async function main(): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    `select id from businesses where name = $1`,
    ["Northgate Services"],
  );
  if (existing) {
    console.log("[seed] tenant already exists, refreshing settings and staff only");
    await query(`update businesses set settings = $2 where id = $1`, [
      existing.id,
      JSON.stringify(settings),
    ]);
    await seedStaff(existing.id);
    await seedConsoleUsers(existing.id);
    await closePool();
    return;
  }

  // The intake token is the tenant's bearer credential for the email webhook.
  // Generated per row rather than derived from the id: a derivable bearer
  // credential is not a credential.
  const business = await queryOne<{ id: string; intake_token: string }>(
    `insert into businesses (name, type, settings, intake_token, intake_address)
     values ($1, $2, $3::jsonb, encode(gen_random_bytes(24), 'hex'), $4)
     returning id, intake_token`,
    [
      "Northgate Services",
      "it_services",
      JSON.stringify(settings),
      "support@northgate.example",
    ],
  );
  const businessId = business!.id;
  console.log(`[seed] business ${businessId}`);
  console.log(`[seed] intake token ${business!.intake_token}`);
  console.log("[seed]   POST /api/intake/email with header x-intake-token");

  await seedStaff(businessId);
  await seedConsoleUsers(businessId);

  const ids = new Map<string, string>();
  for (const p of PEOPLE) {
    const row = await queryOne<{ id: string }>(
      `insert into requesters (business_id, email, full_name, department, role, directory_id, vip, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) returning id`,
      [
        businessId,
        p.email,
        p.name,
        p.dept,
        p.role,
        `entra-${p.email.split("@")[0]}`,
        p.vip,
        JSON.stringify({ groups: defaultGroups(p.dept) }),
      ],
    );
    ids.set(p.email, row!.id);
  }
  console.log(`[seed] ${PEOPLE.length} requesters`);

  for (const d of DEVICES) {
    await query(
      `insert into assets (business_id, requester_id, asset_tag, kind, os, last_seen_at, metadata)
       values ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval, $7::jsonb)`,
      [
        businessId,
        ids.get(d.email),
        d.tag,
        d.kind,
        d.os,
        String(d.daysAgo),
        JSON.stringify({ enrolled: true, disk_encryption: "on" }),
      ],
    );
  }
  console.log(`[seed] ${DEVICES.length} assets`);

  // One live incident, so duplicate linking has something to link to.
  const incident = await queryOne<{ id: string }>(
    `insert into tickets
       (business_id, source, source_message_id, subject, body, status, priority,
        category, subcategory, is_incident, resolution_path, triage_confidence, created_at)
     values ($1,'api',$2,$3,$4,'in_progress','P1','email_collab','Exchange Online outage',
             true,'escalated',0.99, now() - interval '40 minutes')
     returning id`,
    [
      businessId,
      `seed-incident-${Date.now()}`,
      "MAJOR: Exchange Online mail delivery delayed for all users",
      "Microsoft has confirmed a service degradation affecting mail flow in our region. Inbound mail is queued and delivering with 20-40 minute delays. Vendor incident EX9284471. Updates every 30 minutes.",
    ],
  );
  console.log(`[seed] incident ${incident!.id}`);

  await seedHistory(businessId, ids);

  console.log("[seed] done");
  await closePool();
}

/**
 * Idempotent, and run on the refresh path too: a tenant seeded before the staff
 * table existed still needs somebody to assign tickets to.
 */
async function seedStaff(businessId: string): Promise<void> {
  for (const s of STAFF) {
    await upsertStaff({
      business_id: businessId,
      email: s.email,
      full_name: s.name,
      queue: s.queue,
    });
  }
  console.log(`[seed] ${STAFF.length} staff`);
}

/**
 * The people who can sign in to the console.
 *
 * Distinct from `staff`, which is who a ticket is assigned to. A support
 * engineer is usually both, but they are different tables answering different
 * questions: `staff` is "who owns this work", `users` is "who may act".
 */
async function seedConsoleUsers(businessId: string): Promise<void> {
  for (const u of CONSOLE_USERS) {
    const userId = await createUserUnaudited({
      email: u.email,
      fullName: u.name,
      password: SEED_PASSWORD,
    });
    await addMembershipUnaudited(userId, businessId, u.role);
  }

  console.log("");
  console.log(`[seed] ${CONSOLE_USERS.length} console accounts, password: ${SEED_PASSWORD}`);
  for (const u of CONSOLE_USERS) {
    console.log(`[seed]   ${u.role.padEnd(15)} ${u.email}`);
  }
  console.log("");
}

/**
 * Resolved history. Gives the analytics page real numbers on day one and gives
 * the calibration table a starting shape - including a couple of disagreements,
 * because a table where the agent is always right is not a useful table.
 */
async function seedHistory(businessId: string, ids: Map<string, string>): Promise<void> {
  const history = [
    { email: "tom.reed@northgate.example", subject: "Can't sign in to the CRM", category: "access_identity", sub: "SSO login loop", priority: "P2", path: "auto_reply", conf: 0.93, humanCat: "access_identity", humanPri: "P2", days: 2, reopened: 0 },
    { email: "aisha.khan@northgate.example", subject: "Docker Desktop won't start after update", category: "software", sub: "app fails to launch", priority: "P3", path: "escalated", conf: 0.61, humanCat: "software", humanPri: "P3", days: 3, reopened: 0 },
    { email: "mel.hartley@northgate.example", subject: "New starter needs accounts - starts Monday", category: "provisioning", sub: "onboarding", priority: "P4", path: "escalated", conf: 0.88, humanCat: "provisioning", humanPri: "P3", days: 4, reopened: 0 },
    { email: "dan.osei@northgate.example", subject: "Scanner tablet keeps dropping wifi in bay 4", category: "network_connectivity", sub: "wifi coverage", priority: "P3", path: "escalated", conf: 0.71, humanCat: "hardware", humanPri: "P2", days: 5, reopened: 0 },
    { email: "priya.shah@northgate.example", subject: "Password expired, locked out of everything", category: "access_identity", sub: "password expiry", priority: "P2", path: "auto_reply", conf: 0.96, humanCat: "access_identity", humanPri: "P2", days: 6, reopened: 0 },
    { email: "tom.reed@northgate.example", subject: "Teams call audio cuts out", category: "email_collab", sub: "Teams audio", priority: "P3", path: "auto_reply", conf: 0.9, humanCat: "email_collab", humanPri: "P3", days: 7, reopened: 1 },
    { email: "aisha.khan@northgate.example", subject: "Need a Figma seat", category: "software", sub: "licence request", priority: "P4", path: "escalated", conf: 0.94, humanCat: "software", humanPri: "P4", days: 8, reopened: 0 },
    { email: "mel.hartley@northgate.example", subject: "Suspicious email asking for payroll details", category: "security_incident", sub: "suspected phishing", priority: "P1", path: "escalated", conf: 0.97, humanCat: "security_incident", humanPri: "P1", days: 9, reopened: 0 },
  ];

  for (const h of history) {
    const ticket = await queryOne<{ id: string }>(
      `insert into tickets
         (business_id, source, source_message_id, requester_id, subject, body, status,
          priority, category, subcategory, triage_confidence, resolution_path,
          reopened_count, created_at, first_response_at, resolved_at, closed_at)
       values ($1,'email',$2,$3,$4,$5,'closed',$6,$7,$8,$9,$10,$11,
               now() - ($12 || ' days')::interval,
               now() - ($12 || ' days')::interval + interval '6 minutes',
               now() - ($12 || ' days')::interval + interval '3 hours',
               now() - ($12 || ' days')::interval + interval '27 hours')
       returning id`,
      [
        businessId,
        `seed-${h.subject.slice(0, 20)}-${h.days}`,
        ids.get(h.email),
        h.subject,
        `${h.subject}. Reported by ${h.email}.`,
        h.priority,
        h.category,
        h.sub,
        h.conf,
        h.path,
        h.reopened,
        String(h.days),
      ],
    );

    // The agreement booleans are computed here rather than as `$3 = $7` in
    // SQL: comparing two untyped parameters gives Postgres nothing to infer
    // the enum type from, and it refuses the statement.
    await query(
      `insert into triage_shadow
         (business_id, ticket_id, agent_category, agent_priority, agent_confidence,
          agent_path, human_category, human_priority, agreed_category, agreed_priority,
          recorded_at, reconciled_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               now() - ($11 || ' days')::interval,
               now() - ($11 || ' days')::interval + interval '20 minutes')`,
      [
        businessId,
        ticket!.id,
        h.category,
        h.priority,
        h.conf,
        h.path,
        h.humanCat,
        h.humanPri,
        h.category === h.humanCat,
        h.priority === h.humanPri,
        String(h.days),
      ],
    );
  }
  console.log(`[seed] ${history.length} resolved tickets with ground truth`);
}

function defaultGroups(dept: string): string[] {
  const base = ["All-Staff", "VPN-Users"];
  const byDept: Record<string, string[]> = {
    Finance: ["Finance-Team", "SAGE-Users"],
    Sales: ["Sales-Team", "CRM-Users"],
    Engineering: ["Engineering", "AWS-Developers"],
    Operations: ["Warehouse", "Scanner-Devices"],
    HR: ["HR-Team", "Payroll-Readers"],
    Executive: ["Leadership"],
  };
  return [...base, ...(byDept[dept] ?? [])];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
