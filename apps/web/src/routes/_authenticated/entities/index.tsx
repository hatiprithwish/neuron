import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { Plus } from "@phosphor-icons/react";
import { Button } from "@/shadcn/ui/button";
import { cn } from "@/utils/tailwind";
import type * as Schemas from "@app/schemas";
import { formatMetricValue } from "../trackers/-utils";
import { EntitiesQueries } from "./-data";
import EntityRow from "./-EntityRow";
import { combineTotals, KIND_LABELS, KIND_ORDER } from "./-utils";

// DEV_NOTE: one list for every entity kind — the named things any
// tracker's entries link to, in one place, because an entity is shared across trackers by design
// (architecture.md §5).
//
// DEV_NOTE: design/things-mobile.png — the kind picker is a grid of six labelled counts, not a
// select. A dropdown hides how much is behind each option, and "how many accounts do I have" is one
// of the two questions this screen exists to answer; the tabs answer it before anything is clicked.
export const Route = createFileRoute("/_authenticated/entities/")({
  component: EntitiesPage,
});

function EntitiesPage() {
  const { getToken } = useAuth();
  const [kind, setKind] = useState<Schemas.EntityKind>("account");

  // DEV_NOTE: one request for every kind, with usage — not one per tab. The tab counts need the
  // whole set anyway, and switching tabs then costs nothing rather than a fetch each time.
  const { data, isPending, isError } = useQuery(EntitiesQueries.list(undefined, getToken, true));

  const entities = (data?.entities ?? []).filter((entity) => !entity.archivedAt);
  const statsByPublicId = new Map((data?.stats ?? []).map((row) => [row.entityPublicId, row]));

  const visible = entities.filter((entity) => entity.kind === kind);
  const net = combineTotals(
    visible.map((entity) => statsByPublicId.get(entity.publicId)?.total ?? null),
  );

  // DEV_NOTE: full-bleed like -TrackerForm.tsx and the other two screens — sections divided by
  // full-width rules, content inset with px-6, rather than a centred column with empty margins.
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            What your entries point at
          </p>
          <h1 className="font-heading text-3xl font-semibold">Things</h1>
        </div>
        <Button asChild size="icon" aria-label="New thing">
          <Link to="/entities/new">
            <Plus className="size-4" weight="bold" />
          </Link>
        </Button>
      </header>

      {/* DEV_NOTE: a count of 0 is shown, not hidden — an empty kind is information ("no places
          yet"), and a tab strip that changes shape as data arrives is harder to aim at. */}
      <div className="grid grid-cols-3 border-b border-border sm:grid-cols-6">
        {KIND_ORDER.map((option) => {
          const count = entities.filter((entity) => entity.kind === option).length;
          const isActive = option === kind;

          return (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              aria-pressed={isActive}
              className={cn(
                "flex flex-col gap-1 border-r border-border px-6 py-3 text-left transition-colors last:border-r-0",
                isActive ? "bg-muted/40" : "hover:bg-muted/20",
              )}
            >
              <span
                className={cn(
                  "text-xs font-medium tracking-wide uppercase",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {KIND_LABELS[option]}
              </span>
              <span
                className={cn(
                  "text-sm tabular-nums",
                  isActive ? "font-semibold text-primary" : "text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {isPending ? (
        <p className="px-6 py-5 text-muted-foreground">Loading things...</p>
      ) : isError ? (
        <p className="px-6 py-5 text-destructive">Failed to load things.</p>
      ) : visible.length === 0 ? (
        <div className="flex flex-col gap-4 px-6 py-10">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">Nothing of this kind yet.</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {KIND_LABELS[kind].toLowerCase()} are what entries point at — the account a spend came
              out of, the person you spent an evening with. Make one when a tracker needs somewhere
              to file its entries.
            </p>
          </div>
          <Button asChild className="self-start">
            <Link to="/entities/new">New {KIND_LABELS[kind].toLowerCase().replace(/s$/, "")}</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-4 border-b border-border px-6 py-2.5">
            <p className="text-2xs font-medium tracking-widest text-muted-foreground uppercase">
              {visible.length} {KIND_LABELS[kind]}
            </p>
            {/* DEV_NOTE: absent, never zero, when the kind's totals don't combine — see
                combineTotals. A "net 0" across metres and rupees would be a fabricated number. */}
            {net ? (
              <p className="text-sm tabular-nums text-muted-foreground">
                net {formatMetricValue(net.value, net.semanticType, net.canonicalUnit)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col">
            {visible.map((entity) => (
              <EntityRow
                key={entity.publicId}
                entity={entity}
                stats={statsByPublicId.get(entity.publicId) ?? null}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
