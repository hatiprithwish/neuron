import { z } from "zod";
import { ZEntryKind, ZEntryRole } from "./DomainEnums";

// DEV_NOTE: entries is the append-mostly raw log — the source of truth. daily_facts is a derived,
// disposable cache written only by EntriesDAL; it must always be reconstructable by replaying
// entries + entry_values. See architecture.md §5 "entries" / "entry_values" / "entry_entities".
// These three types are DAL/Repo-internal (keyed by entry_id/metric_id/entity_id ints) — domain
// Repos (e.g. HabitsRepo) translate to a narrower, publicId-only API shape before responding, the
// same way HabitsCommon.Habit narrows Tracker.

export const ZEntryBase = z.object({
  entryKind: ZEntryKind.default("point"),
  occurredAt: z.date(),
  endedAt: z.date().nullable().optional(), // interval end; null+interval = open session
  localDate: z.string(), // YYYY-MM-DD, computed at write time in the user's timezone
  tz: z.string(), // IANA, e.g. 'Asia/Kolkata' — stored so local_date can be recomputed after travel
  label: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  source: z.string().default("manual"), // manual | manual_retro | import | api
  transferGroupId: z.string().nullable().optional(),
});
export type EntryBase = z.infer<typeof ZEntryBase>;

// Whole Entry Body — DB shape
// DEV_NOTE: id is the internal autoincrement PK — used by DAL/Repo for joins only, NEVER sent to a
// client. rev is monotonic, server-assigned on every write — a sync ordering key, not yet consumed.
export const ZEntry = ZEntryBase.extend({
  id: z.number(),
  publicId: z.string(),
  userId: z.string(),
  trackerId: z.number(),
  rev: z.number(),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
  deletedAt: z.date().nullable().optional(),
});
export type Entry = z.infer<typeof ZEntry>;

// One entry, many readings — a habit tap has one row here; a meal has four; a workout set has two.
export const ZEntryValueBase = z.object({
  valueNum: z.number().nullable().optional(),
  valueText: z.string().nullable().optional(),
  valueJson: z.string().nullable().optional(),
  currency: z.string().nullable().optional(), // ISO 4217, currency_minor metrics only
  valueBase: z.number().nullable().optional(), // converted to home currency
  fxRate: z.number().nullable().optional(), // rate at entry time — historical rates aren't recoverable
});
export type EntryValueBase = z.infer<typeof ZEntryValueBase>;

export const ZEntryValue = ZEntryValueBase.extend({
  entryId: z.number(),
  metricId: z.number(),
});
export type EntryValue = z.infer<typeof ZEntryValue>;

// One entry, many entities — but one per role (entry_entities' (entry_id, role) primary key is what
// guarantees a "slice by role" donut sums to exactly 100%).
export const ZEntryEntityLink = z.object({
  entryId: z.number(),
  entityId: z.number(),
  role: ZEntryRole,
});
export type EntryEntityLink = z.infer<typeof ZEntryEntityLink>;
