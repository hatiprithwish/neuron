import { z } from "zod";
import { ZEntryRole } from "../core/DomainEnums";
import type {
  DefaultAgg,
  Direction,
  EntityKind,
  EntryRole,
  SemanticType,
} from "../core/DomainEnums";

// DEV_NOTE: architecture.md §6 "Cross-domain aggregation" — "Pushups and running roll into one
// 'Fitness' number because they point at the same entity row." This is the read surface for that:
// one entity, every metric that has ever been attributed to it, over a date range.
//
// DEV_NOTE: docs/archive/implementation.md Phase 4 says "one hand-written query", and that's deliberate — this is
// NOT a generic cross-domain query builder (§7 step 6: "productise only the five or six queries you
// actually re-run"). One entity, one optional role slice, sums per metric.

export const ZEntityRollupQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // DEV_NOTE: invariant 6 — aggregation over entities always filters by exactly one role. Scoping to
  // a single entity already satisfies that (there is nothing to group across), so role is optional
  // here: supply it to answer "spend on this entity *as an account*", omit it for everything that ever
  // pointed at the entity in any role.
  role: ZEntryRole.optional(),
});
export type EntityRollupQuery = z.infer<typeof ZEntityRollupQuery>;

// API response shape — one row per metric attributed to the entity. Metric metadata travels with the
// number because a bare sum is unreadable without its unit and direction (is 4000 good or bad?).
// DEV_NOTE: `value` is the number to render — the metric's own defaultAgg applied across the range,
// so an "averaged per day" metric reports its mean rather than a total nobody asked for. `sum` and
// `count` stay because they are what `value` was derived from: a client showing "82.4 kg · 14
// readings" needs both, and a combined total has to re-derive a weighted mean from them rather than
// averaging the per-metric averages.
export interface EntityRollupMetricRow {
  metricPublicId: string;
  metricKey: string;
  metricName: string;
  semanticType: SemanticType;
  canonicalUnit: string;
  defaultAgg: DefaultAgg;
  direction: Direction;
  value: number | null;
  sum: number;
  count: number;
}

// DEV_NOTE: `combined` is populated only when every contributing metric shares a semantic type and
// canonical unit — adding reps to metres produces a number that means nothing, and invariant 2 is
// explicit that canonical units are what's stored. Two count metrics (pushups + squats) do combine,
// which is the doc's own "Fitness number" example; a count and a distance do not, and the client
// renders the per-metric rows instead of inventing a total.
//
// DEV_NOTE: agreeing on defaultAgg is part of that test now. Summing one metric's total with
// another's average is the same category of error as adding reps to metres — it just doesn't look
// like one, because both halves are numbers in the same unit. `value` carries the shared
// aggregation applied across every contributing metric (a weighted mean for avg, not a mean of
// means), and `defaultAgg` says which one it is so a client can label it.
export interface EntityRollupCombined {
  semanticType: SemanticType;
  canonicalUnit: string;
  defaultAgg: DefaultAgg;
  value: number | null;
  sum: number;
  count: number;
}

export interface EntityRollupApiShape {
  entityPublicId: string;
  entityName: string;
  entityKind: EntityKind;
  from: string;
  to: string;
  role: EntryRole | null;
  metrics: EntityRollupMetricRow[];
  combined: EntityRollupCombined | null;
}
