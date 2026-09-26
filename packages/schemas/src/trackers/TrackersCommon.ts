import { z } from "zod";
import { ZControl, ZDirection, ZEntryRole } from "../core/DomainEnums";
import type { Direction, EntryKind, EntryRole, SemanticType } from "../core/DomainEnums";
import { ZMetricBase } from "../metrics/MetricsCommon";
import { ZComputeKey } from "./ComputeCommon";
import type { TrackerPlanApiShape } from "../trackerPlans/TrackerPlansCommon";

const ZLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// DEV_NOTE: the unit a human types and reads, which is not the unit anything is stored in. A
// duration metric is always canonically seconds (invariant 2, UNIT_FOR_SEMANTIC_TYPE), and every
// read path already converts on the way out — formatMetricValue turns 165 into "2m 45s". The write
// path had no inverse, so a box asking for a duration accepted a bare number and meant seconds by
// it: typing 4 for four minutes stored four seconds, and the target it was scored against had the
// same problem. This field is that inverse's missing half — what the number in the input means.
//
// DEV_NOTE: deliberately NOT on the metric. A metric is user-global and shared across trackers
// (that sharing is what makes cross-tracker rollup possible), while "I think about this one in
// minutes" is a per-tracker reading habit: sleep is hours, meditation minutes, a plank seconds, and
// all three can sit on one `seconds` metric. Same reasoning that moved `direction` here.
export const ZDisplayUnit = z.enum(["seconds", "minutes", "hours"]);
export type DisplayUnit = z.infer<typeof ZDisplayUnit>;

// DEV_NOTE: schedule.type discriminates the shape — see architecture.md §5 "trackers" manifest shape.
export const ZTrackerSchedule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily") }),
  z.object({ type: z.literal("days_of_week"), days: z.array(z.number().min(0).max(6)) }),
  z.object({ type: z.literal("times_per_week"), count: z.number() }),
  // DEV_NOTE: cadence counts from the tracker's own `activeFrom`, not a field on the schedule
  // itself — day 0 is the day the tracker went active, so "every 2 days" set on day one and left
  // alone always lands on the same days. No anchor field to keep in sync with anything.
  z.object({ type: z.literal("every_n_days"), intervalDays: z.number().int().min(2).max(365) }),
]);
export type TrackerSchedule = z.infer<typeof ZTrackerSchedule>;

// DEV_NOTE: `compute` is the escape hatch — a registered module key (see ComputeCommon.ts), not
// free text. Null for everything the seven controls already cover, which is everything except
// Money's transfer.
// DEV_NOTE: `direction` sits here rather than on the metric because it is one half of the same
// judgement as `target` — architecture.md §6 scores a day by comparing the sum against
// target_at_time *using direction*, and splitting the two across two tables put one half of a
// comparison out of reach of the other. It also unblocks the case the metric-level field could not
// express: two trackers on one `minutes` metric, one counting meditation up and one counting
// doomscrolling down, without forking the key and losing the cross-tracker rollup that shared keys
// exist for.
//
// DEV_NOTE: nullable = "inherit metric.defaultDirection". The Repo resolves it to a concrete value
// on write (same as it owns manifest.metrics' primary key), so every stored manifest carries a real
// direction and no read path has to fetch a metric to score a day.
export const ZTrackerManifest = z.object({
  control: ZControl,
  metrics: z.array(z.string()),
  target: z.number().nullable(),
  step: z.number().nullable(),
  direction: ZDirection.nullable(),
  entryMode: z.enum(["live", "retro"]),
  schedule: ZTrackerSchedule,
  compute: ZComputeKey.nullable(),
  // DEV_NOTE: nullable = "read this tracker in its metric's canonical unit", which is the honest
  // answer for every metric that isn't a duration — a count of pushups has no second unit to be
  // typed in.
  // DEV_NOTE: optional as well as nullable, and a `.default()` would have been the wrong tool.
  // manifest_json is a JSON column with no migration behind it, and TrackersDAL reads it with a
  // cast rather than a parse (`manifestJson as TrackerManifest`) — so no default ever runs on the
  // way out, and every row written before today genuinely has no such key. A required field would
  // have typed those rows as carrying a value they don't. Read it as `?? null`.
  displayUnit: ZDisplayUnit.nullable().optional(),
});
export type TrackerManifest = z.infer<typeof ZTrackerManifest>;

// Create Tracker Body
// DEV_NOTE: `icon` is a single emoji chosen from a curated set in the form — presentation only, and
// nullable because a tracker created through the API has no reason to be forced to pick one. Stored
// as text rather than an index into a list so the list can be reordered or grown without rewriting
// rows that already point into it.
// DEV_NOTE: reminderHour is a column, not a manifest key — the notification dispatcher's whole job
// is "find every tracker whose reminder hour is H" (NotificationsDAL.getTrackersDueForReminder), and
// unindexed inside manifest_json that would be a full table scan every hour. It's in the owner's
// timezone (users.tz), which decides WHEN to fire — never which day a row is written under (see
// DateTime.ts). Which days a reminder can fire on is still `manifest.schedule`, already correct.
export const ZTrackerBase = z.object({
  name: z.string(),
  icon: z.string().nullable().optional(),
  colorIndex: z.number().nullable().optional(),
  manifest: ZTrackerManifest,
  sortOrder: z.number().optional(),
  activeFrom: z.string(), // YYYY-MM-DD; heatmaps render nothing before this
  activeTo: z.string().nullable().optional(),
  reminderHour: z.number().int().min(0).max(23).nullable().optional(),
  // DEV_NOTE: the goal entity this tracker counts toward, by public_id — null clears it. The DB
  // holds goal_entity_id (ZTracker below); this is the only form that crosses the API boundary.
  goalPublicId: z.string().nullable().optional(),
});
export type TrackerBase = z.infer<typeof ZTrackerBase>;

// DEV_NOTE: a tracker needs a primary metric, and there are exactly two honest ways to get one:
// point at a metric that already exists (what makes cross-domain aggregation possible — "pushups
// and running roll into one Fitness number", architecture.md §6), or declare a new one inline (what
// every Phase 0–3 hardcoded Repo did). `key` is optional on the new branch: omit it and the Repo
// generates a collision-proof one, since metrics are unique per (user_id, key).
export const ZTrackerMetricSpec = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), metricPublicId: z.string() }),
  z.object({
    mode: z.literal("new"),
    metric: ZMetricBase.omit({ key: true }).extend({ key: z.string().optional() }),
  }),
]);
export type TrackerMetricSpec = z.infer<typeof ZTrackerMetricSpec>;

// Whole Tracker Body — DB shape
// DEV_NOTE: id / primaryMetricId are internal autoincrement PKs — used by DAL/Repo for joins only,
// NEVER sent to a client as-is.
export const ZTracker = ZTrackerBase.omit({ goalPublicId: true }).extend({
  id: z.number(),
  goalEntityId: z.number().nullable(),
  publicId: z.string(),
  userId: z.string(),
  primaryMetricId: z.number(),
  manifestVersion: z.number(),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
  archivedAt: z.date().nullable().optional(),
  deletedAt: z.date().nullable().optional(),
});
export type Tracker = z.infer<typeof ZTracker>;

// DEV_NOTE: manifest.metrics is a list of keys — machine identifiers, not labels. A form control
// rendering one input per declared metric needs the human name and unit too, and asking the client
// to fetch /metrics and join it locally would just move the join somewhere worse.
export interface TrackerMetricDetail {
  metricPublicId: string;
  key: string;
  name: string;
  semanticType: SemanticType;
  canonicalUnit: string;
  // DEV_NOTE: travels with the detail so the tracker form can seed its direction field from the
  // metric the user just pointed at, without a second lookup against /metrics.
  defaultDirection: Direction;
}

// API response shape — internal ids structurally omitted, publicId is client-facing
export type TrackerApiShape = Omit<
  Tracker,
  "id" | "primaryMetricId" | "goalEntityId" | "deletedAt"
> & {
  goalPublicId: string | null;
  primaryMetricPublicId: string;
  primaryMetricKey: string;
  metricDetails: TrackerMetricDetail[];
};

// --- Quick-add: the manifest engine's write surface -------------------------------------------
// DEV_NOTE: architecture.md §6 — "manifest.control picks the quick-add widget". This union is the
// wire half of that: one member per control, so the frontend widget and the backend handler are
// two ends of the same discriminated type instead of seven bespoke endpoints. The Repo rejects a
// payload whose `control` doesn't match the tracker's own manifest.control.

export const ZEntityLinkInput = z.object({
  entityPublicId: z.string(),
  role: ZEntryRole,
});
export type EntityLinkInput = z.infer<typeof ZEntityLinkInput>;

// DEV_NOTE: metricKey (not a publicId) because the manifest itself lists metrics by key — a form
// payload naming a metric the manifest doesn't declare is rejected rather than silently written.
export const ZFormValueInput = z.object({
  metricKey: z.string(),
  valueNum: z.number().nullable().optional(),
  valueText: z.string().nullable().optional(),
  valueJson: z.string().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  fxRate: z.number().positive().nullable().optional(),
});
export type FormValueInput = z.infer<typeof ZFormValueInput>;

export const ZTimerAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    label: z.string().min(1),
    entityLinks: z.array(ZEntityLinkInput).default([]),
  }),
  z.object({ action: z.literal("stop"), entryPublicId: z.string() }),
]);
export type TimerAction = z.infer<typeof ZTimerAction>;

// DEV_NOTE: every control carries entityLinks, not just the money/time-shaped ones. Attribution is
// what makes architecture.md §6's cross-domain rollup possible — "pushups and running roll into one
// Fitness number because they point at the same entity" needs a *count* tracker to be linkable, not
// only an amount or a session. Empty by default, so nothing is forced to care.
export const ZQuickAddPayload = z.discriminatedUnion("control", [
  // Idempotent day set — completed:true is a no-op if already logged, false clears the day.
  z.object({
    control: z.literal("toggle"),
    date: ZLocalDate,
    completed: z.boolean(),
    entityLinks: z.array(ZEntityLinkInput).default([]),
  }),
  // One tap = one entry of manifest.step (default 1). Always additive.
  z.object({
    control: z.literal("increment"),
    date: ZLocalDate,
    note: z.string().nullable().optional(),
    entityLinks: z.array(ZEntityLinkInput).default([]),
  }),
  // Signed multiple of manifest.step — the ± variant of increment.
  z.object({
    control: z.literal("stepper"),
    date: ZLocalDate,
    steps: z.number().int(),
    entityLinks: z.array(ZEntityLinkInput).default([]),
  }),
  // Sets the day's total outright (replaces whatever's logged), rather than adding to it.
  z.object({
    control: z.literal("daily_total"),
    date: ZLocalDate,
    total: z.number(),
    entityLinks: z.array(ZEntityLinkInput).default([]),
  }),
  z.object({
    control: z.literal("amount_pad"),
    date: ZLocalDate,
    amountMinor: z.number().int(),
    currency: z.string().length(3),
    fxRate: z.number().positive(),
    entityLinks: z.array(ZEntityLinkInput).default([]),
    note: z.string().nullable().optional(),
  }),
  z.object({
    control: z.literal("form"),
    date: ZLocalDate,
    values: z.array(ZFormValueInput).min(1),
    entityLinks: z.array(ZEntityLinkInput).default([]),
    label: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  z.object({ control: z.literal("timer"), timer: ZTimerAction }),
]);
export type QuickAddPayload = z.infer<typeof ZQuickAddPayload>;

// --- Read surfaces -----------------------------------------------------------------------------

// API response shape — one entry with its readings and entity links, all publicId-only. Replaces
// HabitEntry / MoneyExpense / TimeSession: every domain reads its entries back through this one
// shape now, and interprets the values it declared in its own manifest.
export interface TrackerEntryValueApiShape {
  metricPublicId: string;
  metricKey: string;
  valueNum: number | null;
  valueText: string | null;
  valueJson: string | null;
  currency: string | null;
  valueBase: number | null;
  fxRate: number | null;
}

export interface TrackerEntryApiShape {
  publicId: string;
  entryKind: EntryKind;
  occurredAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null; // null for point entries and still-running intervals
  localDate: string;
  label: string | null;
  note: string | null;
  transferGroupId: string | null;
  values: TrackerEntryValueApiShape[];
  entities: { entityPublicId: string; role: EntryRole }[];
  createdAt: Date;
}

// DEV_NOTE: architecture.md §6 — four cell states plus "nothing renders before active_from".
// Habits only ever produced three of them (it has no target); a tracker with manifest.target now
// gets "partial" (sum below target) vs "met", and a non-daily manifest.schedule gets
// "not_scheduled" for days it never asked about — which is not the same as a missed day
// (invariant 7: missing data is neutral).
export type TrackerDayState = "not_active" | "not_scheduled" | "no_data" | "partial" | "met";

export interface TrackerHeatmapDay {
  localDate: string;
  state: TrackerDayState;
  // DEV_NOTE: named `sum` for the common case, but it holds whatever the metric's defaultAgg says
  // the day's number is (Aggregation.factValue) — an averaged metric puts its mean here. `state`
  // was scored against this same value, so the two can't disagree.
  sum: number | null;
  target: number | null;
}

// DEV_NOTE: architecture.md §6 "Time-tracker breakdown" — generalised off Time's: `role` is the
// "slice by" parameter, and a null entityPublicId is the explicit left-join bucket for entries with
// no entity in that role, not a dropped row.
export interface TrackerBreakdownRow {
  label: string | null;
  entityPublicId: string | null;
  entryCount: number;
  total: number;
}

// API response shape — a tracker plus everything the Today screen needs to render its quick-add
// widget without a second round trip per row.
export interface TrackerTodayApiShape {
  tracker: TrackerApiShape;
  todaySum: number | null; // null = nothing logged today (invariant 7 — never coalesced to 0)
  todayCount: number;
  streak: number;
  // DEV_NOTE: `today` carries every non-archived tracker (the all-trackers table needs each one's
  // streak); this is what the Today screen filters on. False before activeFrom, on a day the
  // schedule skips, and for a times_per_week tracker whose week is already met (Scoring.isDueOn).
  isDueToday: boolean;
  openSession: TrackerEntryApiShape | null; // timer trackers only
  // DEV_NOTE: every live if-then plan, in the user's order — the capture sheet offers all of them
  // as one-tap triggers, off this same request.
  plans: TrackerPlanApiShape[];
  // DEV_NOTE: the subset the row itself shows as a standing reminder — every plan marked isPriority,
  // and nothing when none are (the user chose not to star anything). A separate field from `plans`
  // because the capture sheet still needs every live plan as a choice, not just the starred ones.
  displayPlans: TrackerPlanApiShape[];
}

// DEV_NOTE: the Today screen's 24h ruler — one tick per entry logged today, across every tracker.
// Deliberately slimmer than TrackerEntryApiShape (no values, no entities): the ruler only ever
// plots occurredAt/endedAt, and fetching the rest per entry would cost a join the ruler doesn't need.
export interface TrackerTimelineEntryApiShape {
  trackerPublicId: string;
  occurredAt: Date;
  endedAt: Date | null;
}

// DEV_NOTE: design/today-web.png's stat strip. Computed by TrackersRepo.getTrackers off the same
// sums/targets it already loads for streaks (invariant: no second range scan for this) — a sibling
// of `today`, not a new endpoint. Every figure but loggedCount/totalCount is null rather than 0 when
// there's nothing to report (invariant 7): a user with no currency_minor tracker has no "spent
// today" to be zero, and 0 there would read as "you spent nothing" instead of "nothing applies".
export interface TrackerTodayStatsApiShape {
  loggedCount: number;
  totalCount: number;
  timeTodaySeconds: number | null;
  spentTodayMinor: number | null;
  // met/scheduled tracker-days over the trailing 7 days (today included), across every tracker —
  // the same not_active/not_scheduled/no_data/partial/met vocabulary Scoring.dayState uses per
  // tracker, summed rather than kept apart. Null when no tracker had a scheduled day in the window.
  sevenDayRatePercent: number | null;
}
