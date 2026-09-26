import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { apiClient } from "@/providers/apiClient";
import type * as Schemas from "@app/schemas";
import { toast } from "sonner";

// DEV_NOTE: replaces HabitsQueries / MoneyQueries / TimeQueries — every domain reads and writes
// through these now. Keys are hierarchical: all() invalidates the list (both plain and withToday),
// detail(publicId) invalidates every per-tracker read (entries, heatmap, breakdown, running).
export class TrackersQueries {
  static readonly keys = {
    all: () => ["trackers"] as const,
    list: (withToday: boolean) => ["trackers", "list", withToday] as const,
    archived: () => ["trackers", "archived"] as const,
    detail: (publicId: string) => ["trackers", publicId] as const,
    entries: (publicId: string) => ["trackers", publicId, "entries"] as const,
    heatmap: (publicId: string) => ["trackers", publicId, "heatmap"] as const,
    breakdown: (publicId: string) => ["trackers", publicId, "breakdown"] as const,
    running: (publicId: string) => ["trackers", publicId, "running"] as const,
    targets: (publicId: string) => ["trackers", publicId, "targets"] as const,
    plans: (publicId: string) => ["trackers", publicId, "plans"] as const,
    moments: (publicId: string) => ["trackers", publicId, "moments"] as const,
    timeline: (date: string) => ["trackers", "timeline", date] as const,
  };

  static list(withToday: boolean, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.list(withToday),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackersApiResponse>(
          `/trackers?withToday=${withToday ? "true" : "false"}`,
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: separate key from list() — restoring has to invalidate both, and a shared key would
  // make the archived screen and the Today screen fight over the same cache entry.
  static archived(getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.archived(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackersApiResponse>("/trackers?archived=true", getToken, { signal }),
    });
  }

  static detail(publicId: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerApiResponse>(`/trackers/${publicId}`, getToken, { signal }),
    });
  }

  static entries(
    publicId: string,
    from: string,
    to: string,
    getToken: () => Promise<string | null>,
  ) {
    return queryOptions({
      queryKey: [...TrackersQueries.keys.entries(publicId), from, to] as const,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerEntriesApiResponse>(
          `/trackers/${publicId}/entries?from=${from}&to=${to}`,
          getToken,
          { signal },
        ),
    });
  }

  static heatmap(
    publicId: string,
    from: string,
    to: string,
    getToken: () => Promise<string | null>,
  ) {
    return queryOptions({
      queryKey: [...TrackersQueries.keys.heatmap(publicId), from, to] as const,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerHeatmapApiResponse>(
          `/trackers/${publicId}/heatmap?from=${from}&to=${to}`,
          getToken,
          { signal },
        ),
    });
  }

  static breakdown(
    publicId: string,
    from: string,
    to: string,
    getToken: () => Promise<string | null>,
    role?: Schemas.EntryRole,
  ) {
    return queryOptions({
      queryKey: [...TrackersQueries.keys.breakdown(publicId), from, to, role ?? "all"] as const,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerBreakdownApiResponse>(
          `/trackers/${publicId}/breakdown?from=${from}&to=${to}${role ? `&role=${role}` : ""}`,
          getToken,
          { signal },
        ),
    });
  }

  static running(publicId: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.running(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetRunningSessionApiResponse>(`/trackers/${publicId}/running`, getToken, {
          signal,
        }),
    });
  }

  // DEV_NOTE: the tracker's goal over time, one row per change. Its own key rather than a slice of
  // detail(), because it is invalidated by things the tracker row isn't (adding an era in the past
  // changes no field on the tracker) and it invalidates things the tracker row doesn't (the heatmap
  // rescores when an era boundary moves).
  static targets(publicId: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.targets(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerTargetsApiResponse>(`/trackers/${publicId}/targets`, getToken, {
          signal,
        }),
    });
  }

  static plans(publicId: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.plans(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerPlansApiResponse>(`/trackers/${publicId}/plans`, getToken, {
          signal,
        }),
    });
  }

  static moments(
    publicId: string,
    from: string,
    to: string,
    getToken: () => Promise<string | null>,
  ) {
    return queryOptions({
      queryKey: [...TrackersQueries.keys.moments(publicId), from, to] as const,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerMomentsApiResponse>(
          `/trackers/${publicId}/moments?from=${from}&to=${to}`,
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: backs the Today screen's ruler — one tick per entry logged today, across every
  // tracker. See docs/redesign-backlog.md for the read side's cross-tracker DEV_NOTE.
  static timeline(date: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: TrackersQueries.keys.timeline(date),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTrackerTimelineApiResponse>(
          `/trackers/today/timeline?date=${date}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useCreateTracker() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: Schemas.CreateTrackerApiRequest) =>
      apiClient<Schemas.CreateTrackerApiResponse>("/trackers", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
    onError: () => {
      toast.error("Failed to create tracker. Please try again.");
    },
  });
}

// DEV_NOTE: the response carries the updated tracker, so the detail cache is written from it
// rather than left showing the pre-edit row until a refetch lands. The list is invalidated on top
// of that — keys.all() is a prefix of every per-tracker key, and today's totals and streaks are
// re-derived server-side from a changed schedule or target, so they have to come back from the API.
export function useUpdateTracker() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ publicId, body }: { publicId: string; body: Schemas.UpdateTrackerApiRequest }) =>
      apiClient<Schemas.UpdateTrackerApiResponse>(`/trackers/${publicId}`, getToken, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: async (response, { publicId }) => {
      if (response.tracker) {
        queryClient.setQueryData<Schemas.GetTrackerApiResponse>(
          TrackersQueries.keys.detail(publicId),
          { isSuccess: true, message: response.message, tracker: response.tracker },
        );
      }
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
    onError: () => {
      toast.error("Failed to update tracker. Please try again.");
    },
  });
}

// DEV_NOTE: both target-history mutations write the whole list back from the response rather than
// refetching it — a write re-cuts the eras around it, and the server already returned the recut
// history. detail() and the heatmap are invalidated on top: the heatmap rescores every day whose
// era boundary moved, and the tracker's own manifest.target follows the newest era.
function useTargetHistoryInvalidation() {
  const queryClient = useQueryClient();

  return async (publicId: string, response: Schemas.WriteTrackerTargetApiResponse) => {
    if (response.targets) {
      queryClient.setQueryData<Schemas.GetTrackerTargetsApiResponse>(
        TrackersQueries.keys.targets(publicId),
        { isSuccess: true, message: response.message, targets: response.targets },
      );
    }
    await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
  };
}

export function useCreateTrackerTarget() {
  const { getToken } = useAuth();
  const syncCache = useTargetHistoryInvalidation();

  return useMutation({
    mutationFn: ({ publicId, target }: { publicId: string; target: Schemas.TrackerTargetBase }) =>
      apiClient<Schemas.WriteTrackerTargetApiResponse>(`/trackers/${publicId}/targets`, getToken, {
        method: "POST",
        body: JSON.stringify({ target }),
      }),
    onSuccess: async (response, { publicId }) => {
      await syncCache(publicId, response);
    },
    onError: () => {
      toast.error("Failed to save target. Please try again.");
    },
  });
}

export function useDeleteTrackerTarget() {
  const { getToken } = useAuth();
  const syncCache = useTargetHistoryInvalidation();

  return useMutation({
    mutationFn: ({ publicId, targetPublicId }: { publicId: string; targetPublicId: string }) =>
      apiClient<Schemas.WriteTrackerTargetApiResponse>(
        `/trackers/${publicId}/targets/${targetPublicId}`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: async (response, { publicId }) => {
      await syncCache(publicId, response);
    },
    onError: () => {
      toast.error("Failed to remove target. Please try again.");
    },
  });
}

// DEV_NOTE: one mutation for all seven controls — the payload is the discriminated union the
// backend's ControlHandlers dispatches on, so a new control needs a widget and a handler, not a new
// endpoint or a new hook.
export function useQuickAdd() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ publicId, payload }: { publicId: string; payload: Schemas.QuickAddPayload }) =>
      apiClient<Schemas.QuickAddApiResponse>(`/trackers/${publicId}/entries`, getToken, {
        method: "POST",
        body: JSON.stringify({ payload }),
      }),
    onSuccess: async (_response, { publicId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() }),
        queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.detail(publicId) }),
      ]);
    },
    onError: () => {
      toast.error("Failed to log entry. Please try again.");
    },
  });
}

export function useRunCompute() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ publicId, compute }: { publicId: string; compute: Schemas.ComputeInput }) =>
      apiClient<Schemas.RunComputeApiResponse>(`/trackers/${publicId}/compute`, getToken, {
        method: "POST",
        body: JSON.stringify({ compute }),
      }),
    onSuccess: async (_response, { publicId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() }),
        queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.detail(publicId) }),
      ]);
    },
    onError: () => {
      toast.error("Failed to run this action. Please try again.");
    },
  });
}

export function useArchiveTracker() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (publicId: string) =>
      apiClient<Schemas.ApiResponse>(`/trackers/${publicId}`, getToken, { method: "DELETE" }),
    onSuccess: async (_response, publicId) => {
      queryClient.removeQueries({ queryKey: TrackersQueries.keys.detail(publicId) });
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
    onError: () => {
      toast.error("Failed to archive tracker. Please try again.");
    },
  });
}

export function useUnarchiveTracker() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (publicId: string) =>
      apiClient<Schemas.UnarchiveTrackerApiResponse>(`/trackers/${publicId}/unarchive`, getToken, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
    onError: () => {
      toast.error("Failed to restore tracker. Please try again.");
    },
  });
}

export function useUnarchiveAllTrackers() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.UnarchiveAllTrackersApiResponse>("/trackers/unarchive-all", getToken, {
        method: "POST",
      }),
    onSuccess: async (response) => {
      toast.success(
        response.restoredCount === 1
          ? "1 tracker restored"
          : `${response.restoredCount ?? 0} trackers restored`,
      );
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
    onError: () => {
      toast.error("Failed to restore trackers. Please try again.");
    },
  });
}

// DEV_NOTE: design/today-web.png's "YOUR ORDER" drag handle. Optimistic — a drag that visibly
// snapped back after every drop would make the list feel broken — so the dragged-to position is
// written to the withToday=true cache immediately and only rolled back if the request fails.
// list(false) (the /trackers/all screen) is left to invalidateQueries on settle rather than patched
// the same way, since it isn't open during a drag on this screen.
export function useReorderTrackers() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (trackerPublicIds: string[]) =>
      apiClient<Schemas.ReorderTrackersApiResponse>("/trackers/reorder", getToken, {
        method: "POST",
        body: JSON.stringify({ trackerPublicIds }),
      }),
    onMutate: async (trackerPublicIds) => {
      await queryClient.cancelQueries({ queryKey: TrackersQueries.keys.list(true) });
      const previous = queryClient.getQueryData<Schemas.GetTrackersApiResponse>(
        TrackersQueries.keys.list(true),
      );

      if (previous?.trackers) {
        const trackerByPublicId = new Map(
          previous.trackers.map((tracker) => [tracker.publicId, tracker]),
        );
        const todayByPublicId = new Map(
          (previous.today ?? []).map((row) => [row.tracker.publicId, row]),
        );

        queryClient.setQueryData<Schemas.GetTrackersApiResponse>(TrackersQueries.keys.list(true), {
          ...previous,
          trackers: trackerPublicIds.flatMap((publicId) => {
            const tracker = trackerByPublicId.get(publicId);
            return tracker ? [tracker] : [];
          }),
          today: previous.today
            ? trackerPublicIds.flatMap((publicId) => {
                const row = todayByPublicId.get(publicId);
                return row ? [row] : [];
              })
            : previous.today,
        });
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(TrackersQueries.keys.list(true), context.previous);
      }
      toast.error("Failed to reorder trackers. Please try again.");
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.all() });
    },
  });
}

// DEV_NOTE: MetricsQueries used to live here. It moved to metrics/-data.ts when metrics got a screen
// of their own — a metric is a user-global resource (architecture.md §5), not a detail of the
// tracker that happened to declare it.

// DEV_NOTE: every plan write answers with the tracker's whole ordered list, so the plans cache is
// written from the response. Only the list reads are invalidated on top (the Today row reads
// isPriority off that list) — keys.all() would also refetch a year of heatmap for a text edit.
function usePlansCacheSync() {
  const queryClient = useQueryClient();

  return async (
    publicId: string,
    plans: Schemas.TrackerPlanApiShape[] | undefined,
    message?: string,
  ) => {
    if (plans) {
      queryClient.setQueryData<Schemas.GetTrackerPlansApiResponse>(
        TrackersQueries.keys.plans(publicId),
        { isSuccess: true, message, plans },
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["trackers", "list"] });
  };
}

export function useCreateTrackerPlan() {
  const { getToken } = useAuth();
  const syncPlans = usePlansCacheSync();

  return useMutation({
    mutationFn: ({ publicId, plan }: { publicId: string; plan: Schemas.TrackerPlanBase }) =>
      apiClient<Schemas.WriteTrackerPlansApiResponse>(`/trackers/${publicId}/plans`, getToken, {
        method: "POST",
        body: JSON.stringify({ plan }),
      }),
    onSuccess: async (response, { publicId }) => {
      await syncPlans(publicId, response.plans, response.message);
    },
    onError: () => {
      toast.error("Failed to save plan. Please try again.");
    },
  });
}

export function useUpdateTrackerPlan() {
  const { getToken } = useAuth();
  const syncPlans = usePlansCacheSync();

  return useMutation({
    mutationFn: ({
      publicId,
      planPublicId,
      plan,
    }: {
      publicId: string;
      planPublicId: string;
      plan: Schemas.UpdateTrackerPlanApiRequest["plan"];
    }) =>
      apiClient<Schemas.WriteTrackerPlansApiResponse>(
        `/trackers/${publicId}/plans/${planPublicId}`,
        getToken,
        { method: "PATCH", body: JSON.stringify({ plan }) },
      ),
    onSuccess: async (response, { publicId }) => {
      await syncPlans(publicId, response.plans, response.message);
    },
    onError: () => {
      toast.error("Failed to update plan. Please try again.");
    },
  });
}

export function useDeleteTrackerPlan() {
  const { getToken } = useAuth();
  const syncPlans = usePlansCacheSync();

  return useMutation({
    mutationFn: ({ publicId, planPublicId }: { publicId: string; planPublicId: string }) =>
      apiClient<Schemas.WriteTrackerPlansApiResponse>(
        `/trackers/${publicId}/plans/${planPublicId}`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: async (response, { publicId }) => {
      await syncPlans(publicId, response.plans, response.message);
    },
    onError: () => {
      toast.error("Failed to remove plan. Please try again.");
    },
  });
}

// DEV_NOTE: mutateAsync callers — the capture sheet awaits this before optionally logging an entry,
// so a failed moment never leaves a stray entry behind it.
export function useCreateTrackerMoment() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const syncPlans = usePlansCacheSync();

  return useMutation({
    mutationFn: ({
      publicId,
      moment,
    }: {
      publicId: string;
      moment: Schemas.CreateTrackerMomentApiRequest["moment"];
    }) =>
      apiClient<Schemas.CreateTrackerMomentApiResponse>(`/trackers/${publicId}/moments`, getToken, {
        method: "POST",
        body: JSON.stringify({ moment }),
      }),
    onSuccess: async (response, { publicId }) => {
      await Promise.all([
        syncPlans(publicId, response.plans, response.message),
        queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.moments(publicId) }),
      ]);
    },
    onError: () => {
      toast.error("Failed to save moment. Please try again.");
    },
  });
}

export function useDeleteTrackerMoment() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ publicId, momentPublicId }: { publicId: string; momentPublicId: string }) =>
      apiClient<Schemas.ApiResponse>(`/trackers/${publicId}/moments/${momentPublicId}`, getToken, {
        method: "DELETE",
      }),
    onSuccess: async (_response, { publicId }) => {
      await queryClient.invalidateQueries({ queryKey: TrackersQueries.keys.moments(publicId) });
    },
    onError: () => {
      toast.error("Failed to remove moment. Please try again.");
    },
  });
}
