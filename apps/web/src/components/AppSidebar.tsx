import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth, UserButton } from "@clerk/tanstack-react-start";
import { useQuery } from "@tanstack/react-query";
import { UsersQueries } from "@/providers/UsersQueries";
import { cn } from "@/utils/tailwind";
import { getLocalDateOf } from "@/utils/timeZone";

interface NavItem {
  to: "/trackers" | "/daily-log" | "/trackers/all" | "/metrics" | "/entities";
  label: string;
  isActive: (pathname: string) => boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/trackers", label: "Today", isActive: (path) => path === "/trackers" },
  { to: "/daily-log", label: "Log", isActive: (path) => path.startsWith("/daily-log") },
  {
    to: "/trackers/all",
    label: "Trackers",
    isActive: (path) => path.startsWith("/trackers/"),
  },
  { to: "/metrics", label: "Metrics", isActive: (path) => path.startsWith("/metrics") },
  { to: "/entities", label: "Things", isActive: (path) => path.startsWith("/entities") },
];

// DEV_NOTE: exported so the Today screen's stat strip (-TodayStatStrip.tsx) can render the same
// "Day N" figure as "Tracking days" without a second implementation of this calc to drift from it.
export function useDayNumber(): number | null {
  const { getToken } = useAuth();
  const { data } = useQuery(UsersQueries.me(getToken));
  // DEV_NOTE: lazy init, not `new Date()` inline — render must stay pure. "Today" only changes once
  // a day, so there's no need for this to tick like -TrackerTimeline.tsx's clock does.
  const [now] = useState(() => new Date());
  const createdAt = data?.user?.createdAt;
  if (!createdAt) return null;

  const startOfCreated = Date.parse(`${getLocalDateOf(new Date(createdAt))}T00:00:00.000Z`);
  const startOfToday = Date.parse(`${getLocalDateOf(now)}T00:00:00.000Z`);

  return Math.round((startOfToday - startOfCreated) / (1000 * 60 * 60 * 24)) + 1;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      {PRIMARY_NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={cn(
            "border-l-2 border-transparent py-1.5 pl-3 text-sm font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground",
            item.isActive(pathname) && "border-primary font-semibold text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}

export function AppSidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="shrink-0 px-5 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <img src="/neuron-logo.png" alt="" className="size-6" />
          <p className="font-heading text-xl font-bold text-sidebar-foreground">neuron</p>
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-5">
        <NavLinks />
      </nav>

      <div className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border px-5 py-4">
        <div className="flex items-center gap-3">
          <Link
            to="/archived"
            className="text-xs text-muted-foreground hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Archived
          </Link>
          <Link
            to="/settings"
            className="text-xs text-muted-foreground hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Settings
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <UserButton />
        </div>
      </div>
    </aside>
  );
}

export function AppBottomNav() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden">
      {PRIMARY_NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(
            "flex-1 py-3 text-center text-xs font-medium tracking-wide uppercase",
            item.isActive(pathname) ? "text-primary" : "text-muted-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
