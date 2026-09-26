import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@/shadcn/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shadcn/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shadcn/ui/select";
import type * as Schemas from "@app/schemas";
import { EntitiesQueries, useUpdateEntity } from "../-data";
import { EntityForm } from "../-EntityForm";
import { AGG_LABELS, addDaysToLocalDate, getTodayLocalDate } from "../../trackers/-utils";

// DEV_NOTE: architecture.md §6 "Cross-domain aggregation" — the surface where trackers stop
// mattering. Everything that ever pointed at this entity is here, whichever tracker wrote it: two
// trackers sharing a metric collapse into one row, and metrics that agree on unit collapse into one
// number.
export const Route = createFileRoute("/_authenticated/entities/$entityId/")({
  component: EntityDetailPage,
});

const WINDOW_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 365 days" },
];

const ALL_ROLES = "__all__";

// DEV_NOTE: null is not zero (invariant 7) — a metric whose aggregate was never computed has no
// value for the range, and an em dash says that where a 0 would claim a reading nobody took.
// Averages arrive with real decimal tails, so they're trimmed to two places; totals stay exact.
function formatRollupValue(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const ROLE_LABELS: Record<Schemas.EntryRole, string> = {
  person: "As a person",
  account: "As an account",
};

function EntityDetailPage() {
  const { entityId } = Route.useParams();
  const { getToken } = useAuth();
  const [windowDays, setWindowDays] = useState("90");
  const [role, setRole] = useState<string>(ALL_ROLES);
  const [isEditing, setIsEditing] = useState(false);
  const updateEntity = useUpdateEntity();

  const today = getTodayLocalDate();
  const from = addDaysToLocalDate(today, -(Number(windowDays) - 1));

  const entityQuery = useQuery(EntitiesQueries.detail(entityId, getToken));
  const rollupQuery = useQuery(
    EntitiesQueries.rollup(
      entityId,
      from,
      today,
      getToken,
      role === ALL_ROLES ? undefined : (role as Schemas.EntryRole),
    ),
  );

  if (entityQuery.isPending) {
    return <div className="mx-auto max-w-2xl p-6">Loading entity...</div>;
  }
  if (entityQuery.isError || !entityQuery.data?.entity) {
    return <div className="mx-auto max-w-2xl p-6 text-destructive">Failed to load entity.</div>;
  }

  const entity = entityQuery.data.entity;
  const rollup = rollupQuery.data?.rollup;

  return (
    <div className="mx-auto max-w-2xl p-6 flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{entity.name}</h1>
          <span className="text-sm text-muted-foreground">{entity.kind}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setIsEditing((current) => !current)}>
            {isEditing ? "Cancel" : "Edit"}
          </Button>
          <Button asChild variant="outline">
            <Link to="/entities">Back</Link>
          </Button>
        </div>
      </div>

      {isEditing ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit entity</CardTitle>
          </CardHeader>
          <CardContent>
            <EntityForm
              submitLabel="Save changes"
              lockKind
              initialValue={{
                name: entity.name,
                kind: entity.kind,
                colorIndex: entity.colorIndex,
                parentPublicId: entity.parentPublicId,
                status: entity.status,
                startedOn: entity.startedOn,
                endedOn: entity.endedOn,
              }}
              onSubmit={async (value) => {
                // DEV_NOTE: kind is dropped rather than sent — the update schema doesn't accept it,
                // and sending a field the server refuses is a lie about what the form can do.
                await updateEntity.mutateAsync({
                  publicId: entity.publicId,
                  entity: {
                    name: value.name,
                    colorIndex: value.colorIndex,
                  },
                });
                setIsEditing(false);
              }}
              onCancel={() => setIsEditing(false)}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Select value={windowDays} onValueChange={setWindowDays}>
          <SelectTrigger className="w-44" aria-label="Date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* DEV_NOTE: invariant 6 — one role at a time, never a mix. "Everything" is safe here only
            because the rollup is already scoped to a single entity. */}
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-48" aria-label="Role slice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL_ROLES}>Every role</SelectItem>
              {(Object.keys(ROLE_LABELS) as Schemas.EntryRole[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rolled up across every tracker</CardTitle>
        </CardHeader>
        <CardContent>
          {rollupQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading rollup...</p>
          ) : rollupQuery.isError ? (
            <p className="text-sm text-destructive">Failed to load rollup.</p>
          ) : !rollup || rollup.metrics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing attributed to this entity in this window.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {rollup.combined ? (
                <div className="flex flex-col gap-1">
                  {/* DEV_NOTE: `value`, not `sum` — the server applies each metric's own
                      aggregation over the range, so an averaged metric shows its mean here rather
                      than a total of every reading it holds. */}
                  <span className="text-3xl font-semibold tabular-nums">
                    {formatRollupValue(rollup.combined.value)}
                    <span className="ml-2 text-base font-normal text-muted-foreground">
                      {rollup.combined.canonicalUnit}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {rollup.metrics.length} metrics {AGG_LABELS[rollup.combined.defaultAgg]} ·{" "}
                    {rollup.combined.count} readings
                  </span>
                </div>
              ) : (
                // DEV_NOTE: mixed units don't add up — reps plus metres is a meaningless number, so
                // the server refuses to invent one and the per-metric rows are the answer. The same
                // refusal now covers metrics that disagree on aggregation: one metric's total plus
                // another's average is the same error wearing a matching unit.
                <p className="text-xs text-muted-foreground">
                  These metrics use different units or aggregations, so they aren&apos;t combined
                  into one number.
                </p>
              )}

              <div className="flex flex-col gap-2">
                {rollup.metrics.map((metric) => (
                  <div
                    key={metric.metricPublicId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      {metric.metricName}
                      <span className="ml-2 text-xs text-muted-foreground">{metric.metricKey}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatRollupValue(metric.value)} {metric.canonicalUnit} · {metric.count}×
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
