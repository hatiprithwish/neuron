import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@/shadcn/ui/button";
import Utilities from "@/utils";
import { addDaysToLocalDate, formatDayLabel, getTodayLocalDate } from "../trackers/-utils";
import { DailyLogsQueries } from "./-data";
import DailyLogEditor from "./-DailyLogEditor";
import DailyLogList from "./-DailyLogList";

// DEV_NOTE: "/daily-log" is always today and "/daily-log/<date>" is any other day — so a link to
// today never goes stale at midnight, and the day links below point at whichever of the two fits.
function DayLink({
  localDate,
  today,
  children,
  label,
}: {
  localDate: string;
  today: string;
  children: ReactNode;
  label: string;
}) {
  return (
    <Button asChild variant="ghost" size="icon-sm" aria-label={label}>
      {localDate === today ? (
        <Link to="/daily-log">{children}</Link>
      ) : (
        <Link to="/daily-log/$localDate" params={{ localDate }}>
          {children}
        </Link>
      )}
    </Button>
  );
}

interface DailyLogDayProps {
  localDate: string;
  getToken: () => Promise<string | null>;
}

export default function DailyLogDay({ localDate, getToken }: DailyLogDayProps) {
  const today = getTodayLocalDate();
  const isValidDate =
    Schemas.ZLocalDate.safeParse(localDate).success &&
    !Number.isNaN(Date.parse(`${localDate}T00:00:00.000Z`));
  const isFuture = isValidDate && localDate > today;
  const canWrite = isValidDate && !isFuture;

  const { data, isPending, isError } = useQuery({
    ...DailyLogsQueries.detail(localDate, getToken),
    enabled: canWrite,
  });

  const previousDay = canWrite ? addDaysToLocalDate(localDate, -1) : today;
  const nextDay = canWrite ? addDaysToLocalDate(localDate, 1) : today;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Daily log
          </p>
          <h1 className="font-heading text-3xl font-semibold">
            {canWrite ? formatDayLabel(localDate) : "Daily log"}
          </h1>
          {canWrite ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {Utilities.formatFullDate(localDate)}
            </p>
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex items-center gap-1">
            <DayLink localDate={previousDay} today={today} label="Previous day">
              <CaretLeft className="size-4" weight="bold" />
            </DayLink>
            {localDate < today ? (
              <DayLink localDate={nextDay} today={today} label="Next day">
                <CaretRight className="size-4" weight="bold" />
              </DayLink>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="grid flex-1 md:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="w-full px-4 py-6 md:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {!isValidDate ? (
              <div className="flex flex-col gap-3 px-8 py-4">
                <p className="text-muted-foreground">That isn't a day we can open.</p>
                <Button asChild className="self-start">
                  <Link to="/daily-log">Go to today</Link>
                </Button>
              </div>
            ) : isFuture ? (
              <div className="flex flex-col gap-3 px-8 py-4">
                <p className="text-muted-foreground">
                  {Utilities.formatFullDate(localDate)} hasn't happened yet — a log is for a day
                  you've lived.
                </p>
                <Button asChild className="self-start">
                  <Link to="/daily-log">Go to today</Link>
                </Button>
              </div>
            ) : isPending ? (
              <p className="px-8 py-4 text-muted-foreground">Loading your log...</p>
            ) : isError ? (
              <p className="px-8 py-4 text-destructive">Failed to load this day's log.</p>
            ) : (
              // DEV_NOTE: keyed by day so moving between days builds a fresh editor seeded with
              // that day's document, and the previous one flushes its pending save on unmount.
              <DailyLogEditor
                key={localDate}
                localDate={localDate}
                initialContent={data.dailyLog?.contentJson ?? null}
              />
            )}
          </div>
        </section>

        <aside className="border-t border-border md:border-t-0 md:border-l">
          <DailyLogList today={today} activeLocalDate={localDate} getToken={getToken} />
        </aside>
      </div>
    </div>
  );
}
