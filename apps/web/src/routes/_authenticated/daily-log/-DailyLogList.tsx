import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/utils/tailwind";
import { addDaysToLocalDate, formatDayLabel } from "../trackers/-utils";
import { DailyLogsQueries } from "./-data";

// DEV_NOTE: a year back from today — the backend caps one request at 400 days, and a year is the
// span "what was I writing around this time last year" needs.
const LIST_WINDOW_DAYS = 365;

interface DailyLogListProps {
  today: string;
  activeLocalDate: string;
  getToken: () => Promise<string | null>;
}

export default function DailyLogList({ today, activeLocalDate, getToken }: DailyLogListProps) {
  const from = addDaysToLocalDate(today, -LIST_WINDOW_DAYS);
  const { data, isPending, isError } = useQuery(DailyLogsQueries.list(from, today, getToken));
  const dailyLogs = data?.dailyLogs ?? [];

  return (
    <div className="flex flex-col">
      <p className="border-b border-border px-6 py-2.5 text-2xs font-medium tracking-widest text-muted-foreground uppercase">
        Past days
      </p>

      {isPending ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">Loading days...</p>
      ) : isError ? (
        <p className="px-6 py-4 text-sm text-destructive">Failed to load past days.</p>
      ) : dailyLogs.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">
          Nothing written yet. Whatever you write about today will be listed here.
        </p>
      ) : (
        <nav aria-label="Past days" className="flex flex-col">
          {dailyLogs.map((dailyLog) => {
            const isActive = dailyLog.localDate === activeLocalDate;
            const className = cn(
              "flex flex-col gap-0.5 border-b border-border border-l-2 border-l-transparent px-6 py-3 transition-colors hover:bg-muted/30",
              isActive && "border-l-primary bg-muted/40",
            );
            const body = (
              <>
                <span
                  className={cn(
                    "text-sm font-medium",
                    isActive ? "text-foreground" : "text-foreground/90",
                  )}
                >
                  {formatDayLabel(dailyLog.localDate)}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {dailyLog.preview}
                </span>
              </>
            );

            return dailyLog.localDate === today ? (
              <Link key={dailyLog.publicId} to="/daily-log" className={className}>
                {body}
              </Link>
            ) : (
              <Link
                key={dailyLog.publicId}
                to="/daily-log/$localDate"
                params={{ localDate: dailyLog.localDate }}
                className={className}
              >
                {body}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
