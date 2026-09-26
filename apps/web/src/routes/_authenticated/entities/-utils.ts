import type * as Schemas from "@app/schemas";
import Utilities from "@/utils";
import { getTodayLocalDate, addDaysToLocalDate } from "../trackers/-utils";

// DEV_NOTE: design/things-mobile.png's tab order — accounts first because money is what most
// entities are, goals last because nothing links to one yet (LINKABLE_KINDS in
// trackers/-utils.ts). Ordering lives here rather than in the schema's ZEntityKind: which tab a user
// sees first is a presentation decision, and the enum is a domain one.
export const KIND_ORDER: Schemas.EntityKind[] = ["account", "person", "goal"];

export const KIND_LABELS: Record<Schemas.EntityKind, string> = {
  account: "Accounts",
  person: "People",
  goal: "Goals",
};

// Used in a row's sub-line ("account · 47 entries"), where the plural tab label would read wrong.
export const KIND_SINGULAR: Record<Schemas.EntityKind, string> = {
  account: "account",
  person: "person",
  goal: "goal",
};

// DEV_NOTE: "last today" beats "last 08-09-2026" for the two dates a reader would otherwise have to
// compare against their own idea of today — the same reasoning as formatStartDate in
// trackers/-utils.ts. Everything older is a plain date; a relative "23 days ago" is harder to place
// than the date itself.
// DEV_NOTE: the year used to be dropped within the current year to save width. DD-MM-YYYY always
// carries it — the format is uniform across the app, and a date that changes shape by how old it is
// costs the reader more than the four characters save.
export function formatLastEntry(localDate: string | null): string {
  if (localDate === null) return "never used";

  const today = getTodayLocalDate();
  if (localDate === today) return "last today";
  if (localDate === addDaysToLocalDate(today, -1)) return "last yesterday";

  return `last ${Utilities.formatFullDate(localDate)}`;
}

// DEV_NOTE: the section header's "net" figure. Same uniformity rule the server applies per entity
// (EntitiesRepo.combine), re-applied one level up: totals only add together when every one of them
// is a sum of the same quantity in the same unit. An average is excluded outright — the mean of
// several entities' means is not a number anyone asked for — so a kind whose totals disagree gets
// no header figure rather than a wrong one.
export function combineTotals(
  totals: (Schemas.EntityStatsTotal | null)[],
): Schemas.EntityStatsTotal | null {
  const present = totals.filter((total): total is Schemas.EntityStatsTotal => total !== null);
  if (present.length === 0) return null;

  const [first] = present;
  if (first.defaultAgg !== "sum") return null;

  const uniform = present.every(
    (total) =>
      total.semanticType === first.semanticType &&
      total.canonicalUnit === first.canonicalUnit &&
      total.defaultAgg === "sum",
  );
  if (!uniform) return null;

  const sum = present.reduce((running, total) => running + total.sum, 0);
  const count = present.reduce((running, total) => running + total.count, 0);

  return { ...first, value: sum, sum, count };
}
