import { useSyncExternalStore } from "react";
import type * as Schemas from "@app/schemas";
import Utilities from "@/utils";
import { getLocalDateOf } from "@/utils/timeZone";

export function getTodayLocalDate(): string {
  return getLocalDateOf(new Date());
}

export function addDaysToLocalDate(localDate: string, delta: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

// 0 = Sunday ... 6 = Saturday, matching the GitHub-style heatmap grid's week layout.
export function dayOfWeek(localDate: string): number {
  return new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
}

// DEV_NOTE: the controls no longer always write today — a heatmap cell hands them an earlier date —
// so every label that used to read "Today" has to say *which* day it is about. Named days stay
// named, because "Yesterday" is how a person refers to it and a date would make them work it out.
export function formatDayLabel(localDate: string): string {
  const today = getTodayLocalDate();
  if (localDate === today) return "Today";
  if (localDate === addDaysToLocalDate(today, -1)) return "Yesterday";
  return new Date(`${localDate}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// The same day as a phrase inside a sentence — "Done today", "Done on Wed 3 Sep".
export function formatDayPhrase(localDate: string): string {
  const label = formatDayLabel(localDate);
  return label === "Today" || label === "Yesterday" ? label.toLowerCase() : `on ${label}`;
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// --- Display units: the inverse of formatMetricValue -------------------------------------------
// DEV_NOTE: formatMetricValue is the one place a canonical number becomes a readable one. This is
// the other direction — the one place a number a human typed becomes a canonical one — and it only
// exists because the write path had no such place. A duration input took a bare number and stored
// it as seconds, so typing 4 for four minutes wrote four seconds; the target field beside it did
// the same, and the two were then compared to each other happily.
//
// DEV_NOTE: seconds is in the list on purpose. It is the identity conversion, which makes "log in
// seconds" a thing a user can choose rather than the silent default they can't see.
const DISPLAY_UNIT_SECONDS: Record<Schemas.DisplayUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

export const DISPLAY_UNIT_LABELS: Record<Schemas.DisplayUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
};

// The short form for an input's suffix, where the field label has already said what it is.
export const DISPLAY_UNIT_SUFFIXES: Record<Schemas.DisplayUnit, string> = {
  seconds: "s",
  minutes: "min",
  hours: "h",
};

// DEV_NOTE: duration is the only semantic type with a display unit today, and the check is on the
// *type* rather than on a flag, so a metric that isn't a duration can't be given one by a stale
// manifest. currency_minor is the other type whose stored unit differs from its typed one, but it
// converts by a fixed 100 with no choice to make (formatMinorAmount / the amount pad), so it needs
// no field.
export function supportsDisplayUnit(semanticType: Schemas.SemanticType): boolean {
  return semanticType === "duration_seconds";
}

// DEV_NOTE: dayState (Scoring.ts) only reads target/direction when target is non-null, and a
// boolean's sum is always exactly 1 on a logged day — never partway — so any target a boolean could
// reach is identical to "logged at all", and direction flips nothing once target is null. Target,
// direction and step are therefore inert on a toggle tracker; whether a day counts is decided by
// schedule alone. Disabling them here keeps that invariant visible instead of discoverable by a
// target nobody could ever miss.
export function supportsTarget(semanticType: Schemas.SemanticType): boolean {
  return semanticType !== "boolean";
}

export const BOOLEAN_TARGET_HELP =
  "A toggle either happened or didn't — its number is always 1 when logged, never partway. " +
  "Target, direction and step exist to grade a partial day, which a boolean can't have. Whether " +
  "today counts is decided by Schedule above, not by these three.";

// DEV_NOTE: null means "this metric has no unit but its canonical one" — every caller reads that as
// "no conversion, no suffix", which is exactly how every control behaved before this existed.
export function resolveDisplayUnit(
  manifest: Schemas.TrackerManifest,
  semanticType: Schemas.SemanticType | undefined,
): Schemas.DisplayUnit | null {
  if (semanticType === undefined || !supportsDisplayUnit(semanticType)) return null;
  return manifest.displayUnit ?? null;
}

// A number as typed → the canonical number stored. Rounded because a duration is whole seconds.
export function toCanonical(value: number, displayUnit: Schemas.DisplayUnit | null): number {
  if (displayUnit === null) return value;
  return Math.round(value * DISPLAY_UNIT_SECONDS[displayUnit]);
}

// DEV_NOTE: the inverse, for seeding an input with a stored value (the edit form's target). Not for
// *rendering* a value — formatMetricValue owns that, and "2m 45s" reads better than "2.75". The
// tail is trimmed because 165 seconds in minutes is 2.75, and an input showing 2.7500000000000004
// is how a round-trip through this function loses a user's trust.
export function toDisplay(canonical: number, displayUnit: Schemas.DisplayUnit | null): number {
  if (displayUnit === null) return canonical;
  return Number((canonical / DISPLAY_UNIT_SECONDS[displayUnit]).toFixed(6));
}

// DEV_NOTE: currency_minor metrics store minor units (paise/cents) — display divides by 100, the
// inverse of what the amount pad does on submit. Canonical units are stored, never display units
// (invariant 2).
export function formatMinorAmount(amountMinor: number, currency?: string | null): string {
  const major = (amountMinor / 100).toFixed(2);
  return currency ? `${currency} ${major}` : major;
}

// DEV_NOTE: the one place a canonical number becomes a readable one, shared by the Things list and
// the tracker detail screen — seconds read as "3h 20m", currency_minor as an amount, and everything
// else as the number beside the unit it was measured in. Storage stays canonical (invariant 2);
// this is presentation, applied as late as possible.
// DEV_NOTE: a null value is an em dash, never a 0 — nothing was measured (invariant 7).
export function formatMetricValue(
  value: number | null,
  semanticType: Schemas.SemanticType,
  canonicalUnit: string,
): string {
  if (value === null) return "—";
  if (semanticType === "duration_seconds") return formatDuration(Math.round(value));
  if (semanticType === "currency_minor") return formatMinorAmount(Math.round(value));
  // Averages arrive with real decimal tails; totals stay exact.
  const number = Number.isInteger(value) ? String(value) : value.toFixed(2);
  // "boolean" as a unit reads as a type name, not a measurement — a summed boolean is a day count.
  if (semanticType === "boolean") return `${number} ${Number(number) === 1 ? "day" : "days"}`;
  return `${number} ${canonicalUnit}`;
}

// DEV_NOTE: the bare name of a control, for places that have already established the context —
// a table column headed "Control", where CONTROL_LABELS' explanatory half is repeated noise nine
// rows down. Kept as its own map rather than split off CONTROL_LABELS at the em dash, because
// parsing a display string to recover half of it makes the punctuation load-bearing.
export const CONTROL_NAMES: Record<Schemas.Control, string> = {
  toggle: "Toggle",
  increment: "Increment",
  stepper: "Stepper",
  daily_total: "Daily total",
  timer: "Timer",
  amount_pad: "Amount",
  form: "Form",
};

export const CONTROL_LABELS: Record<Schemas.Control, string> = {
  toggle: "Toggle — done / not done",
  increment: "Increment — one tap adds a step",
  stepper: "Stepper — add or subtract steps",
  daily_total: "Daily total — set the day's number",
  timer: "Timer — start and stop a session",
  amount_pad: "Amount pad — money-style amount entry",
  form: "Form — several readings at once",
};

// DEV_NOTE: the tile grid is not a list of controls — it is a list of *shapes a tracker can take*,
// and "Transfer" is the one shape that isn't a control at all. A transfer is amount_pad plus the
// money.transfer.v1 compute module (ComputeCommon.ts: the only thing the seven controls
// demonstrably could not express). Making it a tile rather than an eighth ZControl member keeps
// that fact in the presentation layer, where it belongs, instead of forking the write path.
export interface ControlTile {
  key: string;
  label: string;
  hint: string;
  control: Schemas.Control;
  compute: Schemas.ComputeKey | null;
}

export const CONTROL_TILES: ControlTile[] = [
  { key: "toggle", label: "Toggle", hint: "done / not done", control: "toggle", compute: null },
  {
    key: "increment",
    label: "Increment",
    hint: "tap to add one",
    control: "increment",
    compute: null,
  },
  { key: "stepper", label: "Stepper", hint: "+ / − a count", control: "stepper", compute: null },
  {
    key: "daily_total",
    label: "Daily total",
    hint: "one number a day",
    control: "daily_total",
    compute: null,
  },
  { key: "timer", label: "Timer", hint: "start / stop a session", control: "timer", compute: null },
  {
    key: "amount_pad",
    label: "Amount",
    hint: "money keypad",
    control: "amount_pad",
    compute: null,
  },
  { key: "form", label: "Form", hint: "several fields", control: "form", compute: null },
  {
    key: "transfer",
    label: "Transfer",
    hint: "between accounts",
    control: "amount_pad",
    compute: "money.transfer.v1",
  },
];

// DEV_NOTE: a metric's six fields are not six independent decisions — five of them follow from the
// control the moment it's picked. A toggle writes a boolean summed per day; a timer writes seconds.
// Deriving them is what lets the form ask for a name and a control and nothing else, while the
// Change panel keeps every field reachable for the cases the derivation guesses wrong (a daily_total
// tracking body weight wants mass_grams, not count).
//
// DEV_NOTE: units match what the backend already stores for each shape — see the domain tests
// (money.test.ts "currency_minor", time.test.ts "seconds", trackers.test.ts "boolean" / "count").
// Canonical units are stored, never display units (invariant 2).
// DEV_NOTE: `direction` is not derived here any more — it moved onto the tracker's manifest, and
// the form asks for it directly next to the target it is scored against (see DIRECTION_HINT).
// What's left is the shape of the *quantity*, which really is the control's consequence.
export type DerivedMetricShape = Pick<
  Schemas.MetricBase,
  "semanticType" | "canonicalUnit" | "defaultAgg" | "dateAttribution"
>;

export function deriveMetricShape(control: Schemas.Control): DerivedMetricShape {
  const base = { defaultAgg: "sum", dateAttribution: "start" } as const;

  switch (control) {
    case "toggle":
      return { ...base, semanticType: "boolean", canonicalUnit: "boolean" };
    case "timer":
      return { ...base, semanticType: "duration_seconds", canonicalUnit: "seconds" };
    case "amount_pad":
      return { ...base, semanticType: "currency_minor", canonicalUnit: "currency_minor" };
    case "increment":
    case "stepper":
    case "daily_total":
    case "form":
      return { ...base, semanticType: "count", canonicalUnit: "count" };
  }
}

// DEV_NOTE: a control implies which way a tracker usually points, but only as a starting value the
// user can overrule — an amount pad is spending far more often than income, and a timer is time
// spent on something wanted far more often than time to be capped. Separate from
// deriveMetricShape because this seeds a *manifest* field, not a metric one.
export function deriveDirection(control: Schemas.Control): Schemas.Direction {
  return control === "amount_pad" ? "lower_better" : "higher_better";
}

// DEV_NOTE: five of the eleven semantic types name their own unit, and asking for it twice is how
// the form ended up able to store `duration_seconds` measured in "count". A type in this map locks
// the unit field; everything else still needs the answer, because `count` of what (reps, pages,
// cups) and which currency are real questions the type can't answer.
export const UNIT_FOR_SEMANTIC_TYPE: Partial<Record<Schemas.SemanticType, string>> = {
  duration_seconds: "seconds",
  mass_grams: "grams",
  volume_ml: "ml",
  energy_kcal: "kcal",
  distance_m: "metres",
  rating_1_5: "rating",
  boolean: "boolean",
};

export const UNIT_PLACEHOLDER: Partial<Record<Schemas.SemanticType, string>> = {
  count: "reps",
  currency_minor: "INR",
};

// DEV_NOTE: metrics are unique per (user_id, key), and TrackersRepo.createTracker reuses an existing
// metric whose key matches rather than rejecting it. Slugging the tracker's name into the key is
// what makes that reuse land on the right rows: two trackers both called "Pushups" roll into one
// number, while "Take a bath" and "Meditate" stay apart despite both being booleans. Matching on
// semanticType instead would merge every boolean habit a user has, which is data corruption wearing
// a convenience hat.
export function slugifyMetricKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const SEMANTIC_TYPE_LABELS: Record<Schemas.SemanticType, string> = {
  duration_seconds: "duration_seconds",
  count: "count",
  currency_minor: "currency_minor",
  mass_grams: "mass_grams",
  volume_ml: "volume_ml",
  energy_kcal: "energy_kcal",
  distance_m: "distance_m",
  rating_1_5: "rating_1_5",
  boolean: "boolean",
  text: "text",
  json: "json",
};

// DEV_NOTE: labelled by what the target *is* rather than by the enum member's own wording — the
// question a user is answering here is "is this number a floor or a ceiling?", and "neutral" only
// makes sense once it's said as the third answer to that question: neither.
export const DIRECTION_LABELS: Record<Schemas.Direction, string> = {
  higher_better: "more is better",
  lower_better: "less is better",
  neutral: "just tracking",
};

export const DIRECTION_HINTS: Record<Schemas.Direction, string> = {
  higher_better: "The target is a floor. A day at or above it counts, and streaks build on it.",
  lower_better: "The target is a ceiling. A day at or below it counts — a cap, not a goal.",
  neutral: "No good or bad side. Days are recorded, never scored, and no streak runs.",
};

// Shown under the Info icon beside the Direction field.
export const DIRECTION_HELP =
  "Direction is how a day gets scored against its target — and whether a change is read as progress. " +
  "It sits on the tracker, not the metric, because the same measure points different ways for " +
  "different habits: minutes of meditation are worth raising, minutes of doomscrolling are worth " +
  "cutting, and both can share one “minutes” metric so their totals still roll up together.";

export const AGG_LABELS: Record<Schemas.DefaultAgg, string> = {
  sum: "summed per day",
  avg: "averaged per day",
  max: "highest of the day",
  min: "lowest of the day",
};

// DEV_NOTE: which aggregation to pick is a question about the quantity, not about the habit, and
// the wrong answer is silently wrong rather than an error — summing three weigh-ins reports three
// times a body weight. Shown under the Info icon beside the field.
export const AGG_HELP =
  "Aggregation is what one day's number means when a day holds several readings — and it belongs to " +
  "the metric, not this tracker, because it's a fact about the quantity. Reps add up, so pushups are " +
  "summed. Body weight doesn't: three weigh-ins aren't three times your weight, so it's averaged. " +
  "Every tracker writing this metric has to agree, or their numbers can't roll into one.";

export const AGG_HINTS: Record<Schemas.DefaultAgg, string> = {
  sum: "Readings add up. Right for anything countable — reps, pages, minutes, money.",
  avg: "The day's mean. Right for a measurement you take, not accumulate — weight, mood, a rating.",
  max: "The day's highest reading. Right for a personal best.",
  min: "The day's lowest reading. Right for a floor you're watching — a resting heart rate.",
};

// DEV_NOTE: "Today · 08-09-2026" in the design — the word matters more than the date, so the label
// says which of the two it is rather than making the reader compare a date against their own idea
// of today.
export function formatStartDate(localDate: string): string {
  const formatted = Utilities.formatFullDate(localDate);
  return localDate === getTodayLocalDate() ? `Today · ${formatted}` : formatted;
}

// DEV_NOTE: every entry_role is also an entity_kind (architecture.md §3) — an entity of kind
// "account" links through role "account". "goal" entities have no role, so they're not linkable.
export const LINKABLE_KINDS: Schemas.EntryRole[] = ["person", "account"];

export function describeSchedule(schedule: Schemas.TrackerSchedule): string {
  if (schedule.type === "daily") return "Every day";
  if (schedule.type === "times_per_week") return `${schedule.count}× per week`;
  if (schedule.type === "every_n_days") return `Every ${schedule.intervalDays} days`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return schedule.days.map((day) => names[day]).join(", ");
}

// DEV_NOTE: manifest.direction is resolved on write, but the type still allows null — fall back to
// the primary metric's default rather than guessing.
export function resolveTrackerDirection(tracker: Schemas.TrackerApiShape): Schemas.Direction {
  if (tracker.manifest.direction) return tracker.manifest.direction;
  const primary = tracker.metricDetails.find((metric) => metric.key === tracker.primaryMetricKey);
  return primary?.defaultDirection ?? "higher_better";
}

// DEV_NOTE: one stored outcome (held/slipped), two readings — see TrackerMomentOutcomeIntEnum.
export function momentOutcomeWords(direction: Schemas.Direction): {
  held: string;
  slipped: string;
} {
  return direction === "lower_better"
    ? { held: "Resisted", slipped: "Gave in" }
    : { held: "Followed plan", slipped: "Skipped" };
}

// DEV_NOTE: matches Tailwind's `sm` breakpoint (640px). Shared by the moment-capture sheet (bottom
// sheet vs. side panel) and the heatmap (contribution grid vs. month calendar) — both pick a
// genuinely different layout by viewport, not just a resized one, so the choice has to be made in
// JS rather than fought over with conflicting CSS at two specificities (see -MomentCapture.tsx's
// original DEV_NOTE on the sheet's `data-[side=x]` bug this replaced).
export function useIsMobile(breakpointPx = 640): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const query = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
      query.addEventListener("change", onStoreChange);
      return () => query.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia(`(max-width: ${breakpointPx - 1}px)`).matches,
    () => true,
  );
}
