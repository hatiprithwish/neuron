import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@/shadcn/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shadcn/ui/tabs";
import { TrackersQueries, useArchiveTracker, useRunCompute } from "../-data";
import TrackerHeatmap from "../-TrackerHeatmap";
import { TrackerBackfillPanel } from "../-TrackerBackfillPanel";
import { TrackerDailyBars } from "../-TrackerDailyBars";
import { MomentCapture } from "../-MomentCapture";
import { TrackerTriggersTab } from "../-TrackerTriggersTab";
import { deriveTrackerStats, TrackerStatStrip } from "../-TrackerStatStrip";
import { TrackerTargetHistory } from "../-TrackerTargetHistory";
import { TransferForm } from "../-TransferForm";
import {
  addDaysToLocalDate,
  describeSchedule,
  formatDuration,
  formatMetricValue,
  getTodayLocalDate,
} from "../-utils";

// DEV_NOTE: one detail page for every tracker — the heatmap, streak, plans and breakdown are
// all generic reads now. What used to be three domain pages differs here only in which sections
// apply: an interval tracker gets the breakdown, a compute tracker gets its module's form.
//
// DEV_NOTE: full-bleed, matching -TrackerForm.tsx — a centred max-w column left two empty margins
// the width of the content itself on a desktop window, and the panels here (a year of history, a
// log) are exactly the kind that get better with the space. Sections are separated by full-width
// rules with px-6 py-5 cells inside them, which is the form's rhythm, so the two screens read as
// one app rather than two.
const DETAIL_TABS = ["history", "targets", "triggers"] as const;

// DEV_NOTE: the tab lives in the URL so a refresh, a back button or a shared link lands on the same
// tab. Absent means History — the heatmap and streak are what the user most wants to see on
// opening a tracker, so it opens there instead of behind a click. Anything unrecognised in the URL
// is dropped rather than rejected.
export const Route = createFileRoute("/_authenticated/trackers/$trackerId/")({
  validateSearch: (search: Record<string, unknown>): { tab?: (typeof DETAIL_TABS)[number] } => ({
    tab: DETAIL_TABS.find((tab) => tab === search.tab),
  }),
  component: TrackerDetailPage,
});

// DEV_NOTE: 52 weeks, not the mockup's 17 — the mockup is a phone. A year's grid fills the width a
// desktop actually has, and it's what makes "best streak" and the completion rate worth printing:
// over four months both are mostly a statement about how recently the tracker was created.
const HEATMAP_WINDOW_DAYS = 364;
const BREAKDOWN_WINDOW_DAYS = 30;
const MOMENTS_WINDOW_DAYS = 30;

function formatActiveFrom(localDate: string): string {
  return new Date(`${localDate}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border px-6 py-2.5">
      <p className="text-2xs font-medium tracking-widest text-muted-foreground uppercase">
        {title}
      </p>
      {meta ? <p className="text-xs text-muted-foreground tabular-nums">{meta}</p> : null}
    </div>
  );
}

function TrackerDetailPage() {
  const { trackerId } = Route.useParams();
  const { tab = "history" } = Route.useSearch();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const runCompute = useRunCompute();
  const archiveTracker = useArchiveTracker();

  const today = getTodayLocalDate();
  const heatmapFrom = addDaysToLocalDate(today, -(HEATMAP_WINDOW_DAYS - 1));
  const breakdownFrom = addDaysToLocalDate(today, -(BREAKDOWN_WINDOW_DAYS - 1));
  const momentsFrom = addDaysToLocalDate(today, -(MOMENTS_WINDOW_DAYS - 1));

  // The heatmap cell the user opened for logging — null until one is clicked.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const trackerQuery = useQuery(TrackersQueries.detail(trackerId, getToken));
  const heatmapQuery = useQuery(TrackersQueries.heatmap(trackerId, heatmapFrom, today, getToken));
  const targetsQuery = useQuery(TrackersQueries.targets(trackerId, getToken));
  const plansQuery = useQuery(TrackersQueries.plans(trackerId, getToken));
  const momentsQuery = useQuery({
    ...TrackersQueries.moments(trackerId, momentsFrom, today, getToken),
    enabled: tab === "triggers",
  });
  const tracker = trackerQuery.data?.tracker;
  const isInterval = tracker?.manifest.control === "timer";
  // DEV_NOTE: a one-day slice — the backfill panel reaches a year back, and a day it can't see is a
  // day whose control would render against an empty count.
  const selectedDayQuery = useQuery({
    ...TrackersQueries.entries(trackerId, selectedDate ?? today, selectedDate ?? today, getToken),
    enabled: selectedDate !== null,
  });
  const breakdownQuery = useQuery({
    ...TrackersQueries.breakdown(trackerId, breakdownFrom, today, getToken),
    enabled: isInterval,
  });

  if (trackerQuery.isPending) {
    return <div className="px-6 py-8 text-muted-foreground">Loading tracker…</div>;
  }
  if (trackerQuery.isError || !tracker) {
    return <div className="px-6 py-8 text-destructive">Failed to load tracker.</div>;
  }

  const plans = plansQuery.data?.plans ?? [];
  const fetchedDays = heatmapQuery.data?.days ?? [];
  // DEV_NOTE: the fetch always reaches back the full HEATMAP_WINDOW_DAYS regardless of when the
  // tracker started (one query shape, cacheable across trackers of any age) — but rendering that
  // whole window for a tracker created today is 52 weeks of "not_active" padding with nothing in
  // it. Trimmed once here, so the grid, the bar chart, the mobile calendar's paging bounds and the
  // streak/rate stats all agree on where the tracker's history actually begins, instead of each
  // reader re-deriving its own idea of "before this tracker started".
  const days = fetchedDays.filter((day) => day.localDate >= tracker.activeFrom);
  const stats = deriveTrackerStats(days);
  const primaryMetric =
    tracker.metricDetails.find((detail) => detail.key === tracker.primaryMetricKey) ?? null;

  // DEV_NOTE: the % and best-streak cells claim "since active" only when the fetch actually reached
  // back to the day the tracker started — otherwise they are a slice of a longer history, and say
  // so. Unrelated to the trim above: a tracker older than the fetch window still has its leading
  // (unfetched) days absent, just not for the "nothing happened yet" reason this trim addresses.
  const coversStart = heatmapFrom <= tracker.activeFrom;

  // DEV_NOTE: the two cases the engine refuses a past date, checked here so the grid never offers a
  // click whose write would come back a 400: a "live" tracker accepts today only (ControlHandlers'
  // entryMode gate), and a timer's session is always stamped with the server's own clock.
  const canBackfill = tracker.manifest.entryMode === "retro" && !isInterval;
  const selectedDay = selectedDate
    ? (days.find((day) => day.localDate === selectedDate) ?? null)
    : null;

  const heatmapNote = canBackfill
    ? "Click a day to log it."
    : "This tracker only accepts entries for today.";

  const eyebrow = [
    tracker.manifest.control.replace("_", " "),
    describeSchedule(tracker.manifest.schedule),
    tracker.manifest.target !== null && primaryMetric
      ? `target ${formatMetricValue(
          tracker.manifest.target,
          primaryMetric.semanticType,
          primaryMetric.canonicalUnit,
        )}`
      : null,
    `active from ${formatActiveFrom(tracker.activeFrom)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5 sm:py-8">
        <div className="flex min-w-0 items-start gap-3">
          {tracker.icon ? (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-border text-lg">
              {tracker.icon}
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              {eyebrow}
            </p>
            <h1 className="font-heading truncate text-xl font-semibold sm:text-3xl">
              {tracker.name}
            </h1>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          {/* DEV_NOTE: capture only makes sense next to the screen that shows today — on Triggers
              or Targets there is no "today" on screen for a moment to be about. */}
          {tab === "history" ? (
            <MomentCapture tracker={tracker} plans={plans} variant="button" />
          ) : null}
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/trackers" })}>
            Back
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/trackers/$trackerId/edit" params={{ trackerId }}>
              Edit
            </Link>
          </Button>
          {/* DEV_NOTE: archiving is reversible from /archived, so it asks for no confirmation —
              but it does leave the page, since the thing this page is about is no longer in the
              list the user came from. */}
          <Button
            variant="destructive"
            size="sm"
            disabled={archiveTracker.isPending}
            onClick={() =>
              archiveTracker.mutate(tracker.publicId, {
                onSuccess: () => navigate({ to: "/trackers" }),
              })
            }
          >
            Archive
          </Button>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          navigate({
            to: ".",
            search: { tab: DETAIL_TABS.find((known) => known === next) },
            replace: true,
          })
        }
        className="flex flex-1 flex-col gap-0"
      >
        <div className="overflow-x-auto border-b border-border px-6">
          <TabsList variant="line" className="h-14!">
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="targets">Targets</TabsTrigger>
            <TabsTrigger value="triggers">Triggers &amp; Preventions</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="history" className="flex flex-col">
          {heatmapQuery.isError ? (
            <p className="border-b border-border px-6 py-5 text-sm text-destructive">
              Failed to load history.
            </p>
          ) : (
            <TrackerStatStrip
              stats={stats}
              streak={heatmapQuery.data?.streak ?? 0}
              windowDays={HEATMAP_WINDOW_DAYS}
              coversStart={coversStart}
              isPending={heatmapQuery.isPending}
            />
          )}

          <section>
            {heatmapQuery.isPending ? (
              <p className="px-6 py-5 text-sm text-muted-foreground">Loading history…</p>
            ) : heatmapQuery.isError ? null : (
              <TrackerHeatmap
                days={days}
                metric={primaryMetric}
                note={heatmapNote}
                onSelectDay={canBackfill ? setSelectedDate : undefined}
                selectedDate={selectedDate}
              />
            )}
          </section>

          {selectedDay ? (
            <TrackerBackfillPanel
              tracker={tracker}
              day={selectedDay}
              entries={selectedDayQuery.data?.entries ?? []}
              isPending={selectedDayQuery.isPending}
              isError={selectedDayQuery.isError}
              onClose={() => setSelectedDate(null)}
            />
          ) : null}

          {heatmapQuery.isSuccess && tracker.manifest.control !== "toggle" ? (
            <TrackerDailyBars days={days} metric={primaryMetric} />
          ) : null}

          {tracker.manifest.compute === "money.transfer.v1" ? (
            <section>
              <SectionHeading title="Transfer between accounts" />
              <div className="border-b border-border px-6 py-5">
                <TransferForm
                  onSubmit={async (payload) => {
                    await runCompute.mutateAsync({
                      publicId: tracker.publicId,
                      compute: { key: "money.transfer.v1", payload },
                    });
                  }}
                />
              </div>
            </section>
          ) : null}

          {isInterval ? (
            <section>
              <SectionHeading title="Breakdown" meta={`last ${BREAKDOWN_WINDOW_DAYS} days`} />
              {breakdownQuery.isPending ? (
                <p className="px-6 py-5 text-sm text-muted-foreground">Loading breakdown…</p>
              ) : breakdownQuery.isError ? (
                <p className="px-6 py-5 text-sm text-destructive">Failed to load breakdown.</p>
              ) : (breakdownQuery.data?.rows ?? []).length === 0 ? (
                <p className="px-6 py-5 text-sm text-muted-foreground">
                  Nothing logged in this window.
                </p>
              ) : (
                <div className="flex flex-col">
                  {(breakdownQuery.data?.rows ?? []).map((row) => (
                    <div
                      key={row.label ?? "unlabelled"}
                      className="flex items-center justify-between gap-4 border-b border-border px-6 py-3 text-sm"
                    >
                      <span className="truncate">{row.label ?? "Unlabelled"}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {row.entryCount}× · {formatDuration(row.total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="triggers">
          <TrackerTriggersTab
            tracker={tracker}
            plans={plans}
            plansPending={plansQuery.isPending}
            plansError={plansQuery.isError}
            moments={momentsQuery.data?.moments ?? []}
            momentsPending={momentsQuery.isPending}
            momentsError={momentsQuery.isError}
            windowDays={MOMENTS_WINDOW_DAYS}
          />
        </TabsContent>

        {/* DEV_NOTE: under its own tab, not in the edit form. The edit form answers "what am I
            aiming for", which is one number; this answers "what was I aiming for then". */}
        <TabsContent value="targets">
          <TrackerTargetHistory
            tracker={tracker}
            metric={primaryMetric}
            targets={targetsQuery.data?.targets ?? []}
            isPending={targetsQuery.isPending}
            isError={targetsQuery.isError}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
