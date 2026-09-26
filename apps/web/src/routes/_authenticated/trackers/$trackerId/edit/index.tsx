import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { CaretRight } from "@phosphor-icons/react";
import { TrackersQueries, useUpdateTracker } from "../../-data";
import { TrackerForm } from "../../-TrackerForm";

// DEV_NOTE: mirrors new/index.tsx — same full-bleed shell and live preview column, because editing
// a tracker is the same set of decisions as creating one minus the two that are load-bearing for
// history (the control and the metric, both locked by TrackerForm in this mode).
export const Route = createFileRoute("/_authenticated/trackers/$trackerId/edit/")({
  component: EditTrackerPage,
});

function EditTrackerPage() {
  const { trackerId } = Route.useParams();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const updateTracker = useUpdateTracker();

  const trackerQuery = useQuery(TrackersQueries.detail(trackerId, getToken));
  const tracker = trackerQuery.data?.tracker;

  return (
    <div className="flex min-h-screen flex-col">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-2 border-b border-border px-6 py-4 text-xs tracking-widest uppercase"
      >
        <Link
          to="/trackers"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Today
        </Link>
        <CaretRight className="size-3 text-muted-foreground" />
        <Link
          to="/trackers/$trackerId"
          params={{ trackerId }}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          {tracker?.name ?? "Tracker"}
        </Link>
        <CaretRight className="size-3 text-muted-foreground" />
        <span className="font-medium">Edit</span>
      </nav>

      {trackerQuery.isPending ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">Loading tracker...</p>
      ) : trackerQuery.isError || !tracker ? (
        <p className="px-6 py-8 text-sm text-destructive">Failed to load tracker.</p>
      ) : (
        <TrackerForm
          tracker={tracker}
          submitLabel="Save changes"
          // DEV_NOTE: the form emits the create shape in both modes; this is where it narrows to
          // what a PATCH may carry. The manifest fields dropped here (control, metrics, compute)
          // are exactly the ones the API refuses to read, so sending them would be noise the
          // strict schema rejects rather than a silent no-op.
          onSubmit={async (value, meta) => {
            await updateTracker.mutateAsync({
              publicId: tracker.publicId,
              body: {
                // DEV_NOTE: a sibling of `tracker`, not a manifest field — it says from which day
                // the target below starts being what days are scored against, and the backend
                // writes it to the target history rather than to manifest_json. Ignored there
                // unless the target actually changed, so sending it always is safe.
                targetEffectiveFrom: meta.targetEffectiveFrom,
                tracker: {
                  name: value.tracker.name,
                  icon: value.tracker.icon,
                  activeFrom: value.tracker.activeFrom,
                  reminderHour: value.tracker.reminderHour,
                  goalPublicId: value.tracker.goalPublicId,
                  manifest: {
                    target: value.tracker.manifest.target,
                    step: value.tracker.manifest.step,
                    // DEV_NOTE: direction and displayUnit travel with the target because all three
                    // are one judgement about the same number — is it a floor or a ceiling, and in
                    // what unit was it typed. Sending the target without the unit would store a
                    // number in minutes as if it were seconds.
                    direction: value.tracker.manifest.direction,
                    displayUnit: value.tracker.manifest.displayUnit,
                    entryMode: value.tracker.manifest.entryMode,
                    schedule: value.tracker.manifest.schedule,
                  },
                },
              },
            });
            navigate({ to: "/trackers/$trackerId", params: { trackerId } });
          }}
          onCancel={() => navigate({ to: "/trackers/$trackerId", params: { trackerId } })}
        />
      )}
    </div>
  );
}
