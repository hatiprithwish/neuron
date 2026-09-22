import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { apiClient } from "@/providers/apiClient";
import type * as Schemas from "@app/schemas";
import { toast } from "sonner";

// DEV_NOTE: a daily log is addressed by its calendar day (one per user per day), so the detail key
// is the localDate rather than a publicId. all() invalidates every day and every list range.
export class DailyLogsQueries {
  static readonly keys = {
    all: () => ["dailyLogs"] as const,
    lists: () => ["dailyLogs", "list"] as const,
    list: (from: string, to: string) => ["dailyLogs", "list", from, to] as const,
    detail: (localDate: string) => ["dailyLogs", "detail", localDate] as const,
  };

  static detail(localDate: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: DailyLogsQueries.keys.detail(localDate),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetDailyLogApiResponse>(`/daily-log/${localDate}`, getToken, { signal }),
      // DEV_NOTE: the editor only reads this once, as its starting document — a background refetch
      // landing mid-sentence can't change what's on screen, so it would only cost a request.
      staleTime: Infinity,
    });
  }

  static list(from: string, to: string, getToken: () => Promise<string | null>) {
    return queryOptions({
      queryKey: DailyLogsQueries.keys.list(from, to),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetDailyLogsApiResponse>(`/daily-log?from=${from}&to=${to}`, getToken, {
          signal,
        }),
    });
  }
}

// DEV_NOTE: `scope` serialises every save of the same day — autosave fires on a debounce, so two
// saves can be in flight at once, and without a queue the older document could land second and
// overwrite the newer one on the server. setQueryData keeps the detail cache equal to what was
// saved, so returning to the day later opens the latest text without a refetch.
export function useUpsertDailyLog(localDate: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    scope: { id: `daily-log-${localDate}` },
    mutationFn: (body: Schemas.UpsertDailyLogApiRequest) =>
      apiClient<Schemas.UpsertDailyLogApiResponse>(`/daily-log/${localDate}`, getToken, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: async (response) => {
      queryClient.setQueryData<Schemas.GetDailyLogApiResponse>(
        DailyLogsQueries.keys.detail(localDate),
        { isSuccess: true, message: response.message, dailyLog: response.dailyLog ?? null },
      );
      await queryClient.invalidateQueries({ queryKey: DailyLogsQueries.keys.lists() });
    },
    onError: () => {
      toast.error("Couldn't save your log. Your text is still here — keep typing to retry.");
    },
  });
}

export function useDeleteDailyLog() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (localDate: string) =>
      apiClient<Schemas.ApiResponse>(`/daily-log/${localDate}`, getToken, { method: "DELETE" }),
    onSuccess: async (_response, localDate) => {
      queryClient.removeQueries({ queryKey: DailyLogsQueries.keys.detail(localDate) });
      await queryClient.invalidateQueries({ queryKey: DailyLogsQueries.keys.lists() });
    },
    onError: () => {
      toast.error("Failed to delete this log. Please try again.");
    },
  });
}
