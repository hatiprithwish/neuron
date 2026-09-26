import { z } from "zod";

// DEV_NOTE: these mirror architecture.md §3 verbatim — text columns in the DB, not the int+label
// Status Enum Pattern. The doc is explicit these are `text not null` SQL columns, so the DB and the
// wire format use the same string, no int mapping to maintain.

export const ZSemanticType = z.enum([
  "duration_seconds",
  "count",
  "currency_minor",
  "mass_grams",
  "volume_ml",
  "energy_kcal",
  "distance_m",
  "rating_1_5",
  "boolean",
  "text",
  "json",
]);
export type SemanticType = z.infer<typeof ZSemanticType>;

// DEV_NOTE: no `last`. daily_facts stores sum/count/min/max/avg and nothing else, so a "last value
// of the day" was a choice the cache could not answer — it depends on entry ordering the fact row
// throws away, and every read path silently served the sum instead. The `daily_total` control
// already covers what it was for: it replaces the day rather than appending to it, so the day's sum
// *is* its last value. Migration 0004 rewrites the rows that held it.
//
// DEV_NOTE: the four that remain all roll up from the day grain, which is what makes one cache
// enough for week/month/year (architecture.md §1). sum/min/max compose directly; avg does not
// compose as an average of averages and is recomputed as SUM(sum)/SUM(count), which is only
// possible because `count` is stored beside it.
export const ZDefaultAgg = z.enum(["sum", "avg", "max", "min"]);
export type DefaultAgg = z.infer<typeof ZDefaultAgg>;

export const ZDirection = z.enum(["higher_better", "lower_better", "neutral"]);
export type Direction = z.infer<typeof ZDirection>;

export const ZDateAttribution = z.enum(["start", "end", "split"]);
export type DateAttribution = z.infer<typeof ZDateAttribution>;

export const ZEntryKind = z.enum(["point", "interval"]);
export type EntryKind = z.infer<typeof ZEntryKind>;

export const ZEntityKind = z.enum(["person", "goal", "account"]);
export type EntityKind = z.infer<typeof ZEntityKind>;

// DEV_NOTE: one entity per role per entry — enforced by entry_entities' (entry_id, role) primary key.
export const ZEntryRole = z.enum(["person", "account"]);
export type EntryRole = z.infer<typeof ZEntryRole>;

export const ZEntityStatus = z.enum(["active", "paused", "done"]);
export type EntityStatus = z.infer<typeof ZEntityStatus>;

export const ZControl = z.enum([
  "toggle",
  "stepper",
  "increment",
  "timer",
  "daily_total",
  "amount_pad",
  "form",
]);
export type Control = z.infer<typeof ZControl>;
