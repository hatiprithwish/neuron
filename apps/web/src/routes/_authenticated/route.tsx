import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/shadcn/ui/button";
import { apiClient } from "@/providers/apiClient";
import { UsersQueries } from "@/providers/UsersQueries";
import { AppSidebar, AppBottomNav } from "@/components/AppSidebar";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const syncedRef = useRef(false);
  const userQuery = useQuery({ ...UsersQueries.me(getToken), enabled: Boolean(isSignedIn) });

  useEffect(() => {
    if (!isSignedIn || syncedRef.current) return;
    syncedRef.current = true;
    apiClient("/users/clerk-sync", getToken, { method: "POST" }).catch(() => {
      // Non-fatal — user may already exist; errors logged on server
    });
  }, [isSignedIn, getToken]);

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-lg text-muted-foreground">Please sign in to see this page.</p>
        <Button asChild>
          <Link to="/auth/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  // DEV_NOTE: held until /users/me settles (success or failure) so no screen's first render computes
  // "today" in the device zone and then flips once users.tz arrives — see UsersQueries.me.
  // DEV_NOTE: isFetched, not isPending — a refetch of a query that has no data yet puts it back to
  // `pending`, so gating on isPending unmounted every screen on each refetch, the remount started
  // another fetch, and a failing /me looped forever. isFetched stays true once the first request
  // has finished, whatever later refetches do.
  if (!userQuery.isFetched) return null;

  return (
    // DEV_NOTE: min-h-dvh, not min-h-screen — 100vh on a mobile browser measures past the
    // address bar into space the user can't see, so the fixed bottom nav (AppBottomNav) ended up
    // pinned below the visible viewport until the chrome collapsed on scroll. dvh tracks the
    // viewport that's actually on screen.
    <div className="flex min-h-dvh">
      <AppSidebar />
      <main className="min-w-0 flex-1 overflow-x-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <Outlet />
      </main>
      <AppBottomNav />
    </div>
  );
}
