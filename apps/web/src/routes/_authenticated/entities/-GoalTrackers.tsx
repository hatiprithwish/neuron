import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/shadcn/ui/card";
import { TrackersQueries } from "../trackers/-data";
import { formatMetricValue } from "../trackers/-utils";

// DEV_NOTE: a goal has no entry role, so the entity rollup is always empty for one — its evidence
// is the trackers that point at it (trackers.goal_entity_id). Filtered client-side off the Today
// list, which already carries each tracker's streak and today's value, and which the Today screen
// has usually cached already.
export function GoalTrackers({ goalPublicId }: { goalPublicId: string }) {
  const { getToken } = useAuth();
  const trackersQuery = useQuery(TrackersQueries.list(true, getToken));

  const linked = (trackersQuery.data?.today ?? []).filter(
    (row) => row.tracker.goalPublicId === goalPublicId,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trackers toward this goal</CardTitle>
      </CardHeader>
      <CardContent>
        {trackersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading trackers...</p>
        ) : trackersQuery.isError ? (
          <p className="text-sm text-destructive">Failed to load trackers.</p>
        ) : linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trackers linked yet. Pick this goal when you edit a tracker.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {linked.map(({ tracker, todaySum, streak }) => {
              const primary = tracker.metricDetails.find(
                (metric) => metric.metricPublicId === tracker.primaryMetricPublicId,
              );
              return (
                <Link
                  key={tracker.publicId}
                  to="/trackers/$trackerId"
                  params={{ trackerId: tracker.publicId }}
                  className="flex items-center justify-between gap-4 py-3 text-sm hover:text-foreground"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {tracker.icon ? <span aria-hidden>{tracker.icon}</span> : null}
                    <span className="truncate">{tracker.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {primary
                      ? `Today ${formatMetricValue(todaySum, primary.semanticType, primary.canonicalUnit)}`
                      : null}
                    {streak > 0 ? ` · ${streak} day streak` : ""}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
