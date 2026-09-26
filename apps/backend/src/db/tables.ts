import { sql } from "drizzle-orm";
import { sqliteTable as table } from "drizzle-orm/sqlite-core";
import * as t from "drizzle-orm/sqlite-core";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: SQLite does not have bigInt support

// DEV_NOTE: no `AUTOINCREMENT` anywhere below — see architecture.md §4: it writes to
// sqlite_sequence on every insert for a guarantee (deleted rowids never reused) that's moot once
// every table only ever soft-deletes. `integer primary key` alone is already the SQLite rowid.
// DEV_NOTE: no table declares `references` — see architecture.md §4.1. Relationship columns are
// indexed exactly as if they were constrained; the repository layer validates on write instead.

export const users = table(
  "users",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    clerkId: t.text("clerk_id").notNull(),
    email: t.text().notNull(),
    role: t.text().$type<Schemas.UserRoleEnum>().notNull(),
    tz: t.text().notNull().default("Asia/Kolkata"),
    homeCurrency: t.text("home_currency").notNull().default("INR"),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }).notNull(),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_users_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_users_clerk_id").on(table.clerkId),
    t.uniqueIndex("UNQ_users_email").on(table.email),
  ],
);

// DEV_NOTE: declared globally per user, reused across trackers — see architecture.md §5 "metrics".
export const metrics = table(
  "metrics",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    key: t.text().notNull(),
    name: t.text().notNull(),
    semanticType: t.text("semantic_type").$type<Schemas.SemanticType>().notNull(),
    canonicalUnit: t.text("canonical_unit").notNull(),
    defaultAgg: t.text("default_agg").$type<Schemas.DefaultAgg>().notNull().default("sum"),
    // DEV_NOTE: a *default* only — the tracker's manifest owns the direction a day is scored by
    // (ZTrackerManifest.direction). This is what a new tracker inherits, and what the cross-tracker
    // rollup reads, since a rollup spans every tracker on the metric and has no one manifest to ask.
    defaultDirection: t
      .text("default_direction")
      .$type<Schemas.Direction>()
      .notNull()
      .default("higher_better"),
    dateAttribution: t
      .text("date_attribution")
      .$type<Schemas.DateAttribution>()
      .notNull()
      .default("start"),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_metrics_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_metrics_user_id_key").on(table.userId, table.key),
    t
      .index("IDX_metrics_user_id")
      .on(table.userId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: goals/people/accounts — the shared "named thing to attach entries to" across every
// domain, linked in via entry_entities' role-scoped join. Live outside trackers so the same entity
// can be referenced from any number of them. See architecture.md §5 "entities".
export const entities = table(
  "entities",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    kind: t.text().$type<Schemas.EntityKind>().notNull(),
    name: t.text().notNull(),
    colorIndex: t.integer("color_index"), // index into the --chart-N categorical scale
    parentId: t.integer("parent_id"),
    status: t.text().$type<Schemas.EntityStatus>(),
    startedOn: t.text("started_on"), // YYYY-MM-DD
    endedOn: t.text("ended_on"),
    sortOrder: t.integer("sort_order").notNull().default(0),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    archivedAt: t.integer("archived_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_entities_public_id").on(table.publicId),
    t
      .index("IDX_entities_user_id")
      .on(table.userId)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_entities_user_id_kind")
      .on(table.userId, table.kind)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: free-form key/value extension on an entity (e.g. a "goal" entity's target_date). No
// independent identity — composite PK, no public_id. See architecture.md §4 "Which tables get a
// public_id". Not read/written by anything yet; the column shape alone is what the doc specifies.
export const entityAttrs = table(
  "entity_attrs",
  {
    entityId: t.integer("entity_id").notNull(),
    key: t.text().notNull(),
    valueNum: t.real("value_num"),
    valueText: t.text("value_text"),
  },
  (table) => [t.primaryKey({ columns: [table.entityId, table.key] })],
);

// DEV_NOTE: a saved configuration — adding a tracker is a row insert, not a deploy. manifest_json
// decides what UI to render (manifest.control) and which metrics to write. See architecture.md §5
// "trackers".
export const trackers = table(
  "trackers",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    name: t.text().notNull(),
    icon: t.text(), // single emoji, chosen from a curated set in the form
    colorIndex: t.integer("color_index"),
    primaryMetricId: t.integer("primary_metric_id").notNull(),
    manifestJson: t
      .text("manifest_json", { mode: "json" })
      .$type<Schemas.TrackerManifest>()
      .notNull(),
    manifestVersion: t.integer("manifest_version").notNull().default(1),
    sortOrder: t.integer("sort_order").notNull().default(0),
    activeFrom: t.text("active_from").notNull(), // YYYY-MM-DD; heatmaps render nothing before this
    activeTo: t.text("active_to"), // set when paused/retired
    // DEV_NOTE: the owner's timezone (users.tz), not UTC — see ZTrackerBase's DEV_NOTE. Nullable:
    // most trackers have no reminder. Partial-indexed below so the hourly dispatch's "every tracker
    // whose reminder hour is H" is an index seek, not a table scan.
    reminderHour: t.integer("reminder_hour"),
    // DEV_NOTE: the one goal this tracker is evidence for — an entity of kind "goal", validated by
    // TrackersRepo on write (no `references`, architecture.md §4.1). Nullable: most trackers serve
    // no named goal, and a tracker is never required to justify itself.
    goalEntityId: t.integer("goal_entity_id"),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    archivedAt: t.integer("archived_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_trackers_public_id").on(table.publicId),
    t
      .index("IDX_trackers_user_id")
      .on(table.userId)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_trackers_reminder_hour")
      .on(table.reminderHour, table.userId)
      .where(sql`${table.reminderHour} is not null and ${table.deletedAt} is null`),
    t
      .index("IDX_trackers_goal_entity_id")
      .on(table.goalEntityId)
      .where(sql`${table.goalEntityId} is not null and ${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: a tracker's goal over time, one row per change — see ZTrackerTargetsCommon for why
// daily_facts.target_at_time (still unwritten, kept for the rollup shape it describes) could not
// carry this: no tracker in its key, no row on unlogged days, and stamped at entry time so a
// backfill would date-stamp an old day with today's goal. Rows are appended, never rewritten by a
// new goal, so raising a target opens a new era instead of rescoring every day already lived.
// `target` null = "no target from this date", which is how every tracker reads before its owner
// first set one.
export const trackerTargets = table(
  "tracker_targets",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    trackerId: t.integer("tracker_id").notNull(),
    effectiveFrom: t.text("effective_from").notNull(), // YYYY-MM-DD
    target: t.real(), // canonical units, like manifest.target
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_tracker_targets_public_id").on(table.publicId),
    // DEV_NOTE: partial, unlike the publicId index above — one tracker has exactly one target per
    // day, but a soft-deleted row must not block setting a target for that date again (invariant 9
    // keeps the row; it shouldn't also keep the date reserved).
    t
      .uniqueIndex("UNQ_tracker_targets_tracker_id_effective_from")
      .on(table.trackerId, table.effectiveFrom)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_tracker_targets_tracker_id")
      .on(table.trackerId, table.effectiveFrom)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: if-then plans — a trigger and what to do when it fires. Hangs off trackers only (not
// entries) so it is untouched by any change to how readings are stored.
export const trackerPlans = table(
  "tracker_plans",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    trackerId: t.integer("tracker_id").notNull(),
    cue: t.text().notNull(),
    response: t.text(),
    isPriority: t.integer("is_priority", { mode: "boolean" }).notNull().default(false),
    sortOrder: t.integer("sort_order").notNull().default(0),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_tracker_plans_public_id").on(table.publicId),
    t
      .index("IDX_tracker_plans_tracker_id")
      .on(table.trackerId, table.sortOrder)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: a trigger firing — held or slipped. Never read by scoring; see ZTrackerMoment.
export const trackerMoments = table(
  "tracker_moments",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    trackerId: t.integer("tracker_id").notNull(),
    planId: t.integer("plan_id"),
    momentOutcome: t
      .integer("moment_outcome")
      .$type<Schemas.TrackerMomentOutcomeIntEnum>()
      .notNull(),
    localDate: t.text("local_date").notNull(), // YYYY-MM-DD, UTC day like entries.local_date
    occurredAt: t.integer("occurred_at", { mode: "timestamp" }).notNull(),
    note: t.text(),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_tracker_moments_public_id").on(table.publicId),
    t
      .index("IDX_tracker_moments_tracker_id_local_date")
      .on(table.trackerId, table.localDate)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_tracker_moments_plan_id")
      .on(table.planId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: entries is the append-mostly raw log — the source of truth. entry_values/entry_entities
// (below) carry the actual readings/links; daily_facts is a derived, disposable cache written only
// by EntriesDAL. See architecture.md §5 "entries".
export const entries = table(
  "entries",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    trackerId: t.integer("tracker_id").notNull(),
    entryKind: t.text("entry_kind").$type<Schemas.EntryKind>().notNull().default("point"),
    occurredAt: t.integer("occurred_at", { mode: "timestamp" }).notNull(), // unix seconds, UTC instant
    endedAt: t.integer("ended_at", { mode: "timestamp" }), // interval end; null+interval = open session
    localDate: t.text("local_date").notNull(), // YYYY-MM-DD, resolved at write time
    tz: t.text().notNull(), // IANA, e.g. 'Asia/Kolkata'
    label: t.text(), // free-text description; drill-down groups on this
    note: t.text(),
    source: t.text().notNull().default("manual"), // manual | manual_retro | import | api
    transferGroupId: t.text("transfer_group_id"), // links the two sides of an account transfer
    rev: t.integer().notNull().default(0), // monotonic; sync ordering key
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_entries_public_id").on(table.publicId),
    t
      .index("IDX_entries_user_id_local_date")
      .on(table.userId, table.localDate)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_entries_tracker_id_local_date")
      .on(table.trackerId, table.localDate)
      .where(sql`${table.deletedAt} is null`),
    // DEV_NOTE: backs NotificationsDAL.getOpenIntervalsForUsers (PR 4's open-interval nag) — an
    // almost-empty partial index (at most one open interval per tracker at a time), so it costs
    // nothing to maintain and turns "which of these users have a timer running" into an index seek.
    t
      .index("IDX_entries_open_interval")
      .on(table.userId, table.occurredAt)
      .where(
        sql`${table.entryKind} = 'interval' and ${table.endedAt} is null and ${table.deletedAt} is null`,
      ),
  ],
);

// DEV_NOTE: one entry, many readings — a habit tap has one row here; a meal has four; a workout set
// has two. No independent identity — composite PK, no public_id.
export const entryValues = table(
  "entry_values",
  {
    entryId: t.integer("entry_id").notNull(),
    metricId: t.integer("metric_id").notNull(),
    valueNum: t.real("value_num"),
    valueText: t.text("value_text"),
    valueJson: t.text("value_json"),
    currency: t.text(), // ISO 4217, currency_minor only
    valueBase: t.real("value_base"), // converted to home currency
    fxRate: t.real("fx_rate"), // rate at entry time
  },
  (table) => [
    t.primaryKey({ columns: [table.entryId, table.metricId] }),
    t.index("IDX_entry_values_metric_id").on(table.metricId, table.entryId),
  ],
);

// DEV_NOTE: one entry, many entities — but one per role. The PK on (entry_id, role) is what
// guarantees a "slice by role" donut sums to exactly 100%.
export const entryEntities = table(
  "entry_entities",
  {
    entryId: t.integer("entry_id").notNull(),
    entityId: t.integer("entity_id").notNull(),
    role: t.text().$type<Schemas.EntryRole>().notNull(),
  },
  (table) => [
    t.primaryKey({ columns: [table.entryId, table.role] }),
    t.index("IDX_entry_entities").on(table.entityId, table.role, table.entryId),
  ],
);

// DEV_NOTE: materialized rollup, upserted by EntriesDAL alongside every entries write/delete — the
// only thing dashboards/aggregations should ever query. No id/publicId: never addressed individually
// by a client, only ever fetched by range query. min/max/avg are nullable — invariant 7: missing
// data is neutral, never coalesced to 0. entityId IS NULL is the canonical, un-attributed total.
export const dailyFacts = table(
  "daily_facts",
  {
    userId: t.text("user_id").notNull(),
    localDate: t.text("local_date").notNull(),
    metricId: t.integer("metric_id").notNull(),
    entityId: t.integer("entity_id"),
    sum: t.real().notNull(),
    count: t.integer().notNull(),
    min: t.real(),
    max: t.real(),
    avg: t.real(),
    // DEV_NOTE: never written — always null. architecture.md §6 reserved it for "keeps history
    // honest when goals change", and that job belongs to tracker_targets instead: this row's key
    // has no tracker in it (two trackers on one metric would share the slot), it only exists on
    // days something was logged, and it would be stamped at entry time, so backfilling August
    // today would record today's goal against an August day. Kept as the column the doc describes;
    // nothing reads it.
    targetAtTime: t.real("target_at_time"),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    t.primaryKey({
      columns: [table.userId, table.localDate, table.metricId, table.entityId],
    }),
    t.index("IDX_daily_facts_lookup").on(table.userId, table.metricId, table.localDate),
  ],
);

// DEV_NOTE: one free-form note per user per calendar day, written in the web app's block editor.
// Kept out of `entries` on purpose — an entry belongs to a tracker and feeds entry_values/daily_facts,
// and a note has no tracker, no metric and nothing to aggregate (architecture.md §9: text values get
// no fact rows). content_json is the editor's Tiptap document; content_text is its plain-text
// projection, derived by DailyLogsRepo on every write. The (user_id, local_date) unique index is
// partial on deleted_at is null, like push_subscriptions.endpoint, so clearing a day and writing it
// again inserts a fresh row instead of colliding with the soft-deleted one (invariant 9).
export const dailyLogs = table(
  "daily_logs",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    localDate: t.text("local_date").notNull(), // YYYY-MM-DD, the owner's own calendar day
    tz: t.text().notNull(), // IANA zone users.tz held when the day was last written
    contentJson: t.text("content_json", { mode: "json" }).$type<Schemas.TiptapDoc>().notNull(),
    contentText: t.text("content_text").notNull(),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_daily_logs_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_daily_logs_user_id_local_date")
      .on(table.userId, table.localDate)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: one row per uploaded object. The bytes live in R2 (binding MEDIA); this row is what
// proves who owns them, what was stored, and — via the daily log's reference diffing — what is
// still pointed at. public_id doubles as the R2 key's last segment and as the capability in the
// URL, so it is the only identifier a client ever sees (invariant 11 still holds: `id` stays in).
export const mediaObjects = table(
  "media_objects",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    r2Key: t.text("r2_key").notNull(),
    contentType: t.text("content_type").notNull(),
    bytes: t.integer().notNull(),
    width: t.integer(),
    height: t.integer(),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_media_objects_public_id").on(table.publicId),
    t
      .index("IDX_media_objects_user_id")
      .on(table.userId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: the endpoint unique index is global, not per-user, and partial on deleted_at is null —
// a push service issues one endpoint per browser-install/origin pair, so if user A signs out and
// user B signs in on the same machine, the browser hands back the same endpoint. Per-user uniqueness
// would leave A's row live and deliver B's reminders to a channel A's device owns. Partial, like
// tracker_targets above, so a soft-deleted row doesn't reserve the endpoint forever (invariant 9).
export const pushSubscriptions = table(
  "push_subscriptions",
  {
    id: t.int().primaryKey(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    endpoint: t.text().notNull(),
    p256dh: t.text().notNull(),
    auth: t.text().notNull(),
    deviceLabel: t.text("device_label").notNull(),
    lastSeenAt: t.integer("last_seen_at", { mode: "timestamp" }).notNull(),
    lastSentAt: t.integer("last_sent_at", { mode: "timestamp" }),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
    deletedAt: t.integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_push_subscriptions_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_push_subscriptions_endpoint")
      .on(table.endpoint)
      .where(sql`${table.deletedAt} is null`),
    t
      .index("IDX_push_subscriptions_user_id")
      .on(table.userId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

// DEV_NOTE: its own table rather than columns on `users` — `users` is the auth identity row,
// written by exactly one path (clerk-sync's upsert) and read by clerk_id in one place; handing a
// settings screen a PATCH onto it widens the blast radius on the row every request authenticates
// against. This preference set also grows (quiet hours, per-channel routing are the obvious next
// asks), and widening `users` once per feature is how a five-column identity table becomes a junk
// drawer. `tz` stays on `users` regardless — a locale fact invariant 4 already names, not a
// notification preference.
// DEV_NOTE: no publicId — architecture.md §4 grants one iff a row can appear in a URL, and this is
// only ever addressed as "mine" (the authenticated user's own row). No deletedAt — turning every
// trigger off is `false` on the row, not a delete; "no row" means never-configured (see
// NOTIFICATION_PREFS_DEFAULTS). First `{ mode: "boolean" }` columns in the schema — flags, not
// discrete states, so the Status Enum Pattern doesn't apply.
export const notificationPrefs = table("notification_prefs", {
  userId: t.text("user_id").primaryKey(),
  trackerRemindersEnabled: t.integer("tracker_reminders_enabled", { mode: "boolean" }).notNull(),
  streakDigestEnabled: t.integer("streak_digest_enabled", { mode: "boolean" }).notNull(),
  streakDigestHour: t.integer("streak_digest_hour").notNull(),
  openIntervalEnabled: t.integer("open_interval_enabled", { mode: "boolean" }).notNull(),
  openIntervalThresholdMinutes: t.integer("open_interval_threshold_minutes").notNull(),
  createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: t.integer("updated_at", { mode: "timestamp" }),
});

// DEV_NOTE: the only atomic claim available with no KV and no Queue — a unique index in D1. The
// dispatcher inserts BEFORE it sends; a conflict means somebody already claimed this
// (user, dedupKey) — a cron retry, or two invocations in the same hour — and that branch skips.
// Insert-before-send means a failed send is not retried, which is the right trade: a missed
// reminder is a nuisance, a duplicate at 07:00 is why people turn notifications off.
// DEV_NOTE: no publicId (never in a URL). No deletedAt — nothing ever deletes a row, so invariant 9
// is satisfied trivially rather than by a column that would never be written.
export const notificationSends = table(
  "notification_sends",
  {
    userId: t.text("user_id").notNull(),
    dedupKey: t.text("dedup_key").notNull(),
    trigger: t.text().$type<Schemas.NotificationTrigger>().notNull(),
    sentAt: t.integer("sent_at", { mode: "timestamp" }).notNull(),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [t.primaryKey({ columns: [table.userId, table.dedupKey] })],
);
