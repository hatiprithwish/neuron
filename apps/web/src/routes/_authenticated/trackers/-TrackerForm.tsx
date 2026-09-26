import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { z } from "zod";
import { InfoHint } from "@/components/InfoHint";
import { Button } from "@/shadcn/ui/button";
import { Input } from "@/shadcn/ui/input";
import { FieldError } from "@/shadcn/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/shadcn/ui/select";
import { cn } from "@/utils/tailwind";
import * as Schemas from "@app/schemas";
import { EntitiesQueries } from "../entities/-data";
import { MetricsQueries } from "../metrics/-data";
import { IconPicker } from "./-IconPicker";
import { TrackerPreview } from "./-TrackerPreview";
import {
  AGG_HELP,
  AGG_HINTS,
  AGG_LABELS,
  BOOLEAN_TARGET_HELP,
  CONTROL_TILES,
  DISPLAY_UNIT_LABELS,
  DIRECTION_HELP,
  DIRECTION_HINTS,
  DIRECTION_LABELS,
  UNIT_FOR_SEMANTIC_TYPE,
  UNIT_PLACEHOLDER,
  deriveDirection,
  deriveMetricShape,
  formatStartDate,
  getTodayLocalDate,
  slugifyMetricKey,
  supportsDisplayUnit,
  supportsTarget,
  toCanonical,
  toDisplay,
} from "./-utils";

// DEV_NOTE: this form *is* the manifest engine's front door — everything Phase 0–3 hardcoded per
// domain (which control, which metric, which schedule) is a field here. Creating "another toggle
// habit" through it writes no new code anywhere, which is docs/archive/implementation.md Phase 6's
// acceptance test.
//
// DEV_NOTE: the form is flat and converted to the nested API shape on submit — same approach as the
// old expense form, which typed amounts in major units and converted to minor.
//
// DEV_NOTE: the metric is derived, not asked for. Two earlier versions of this form both got it
// wrong in opposite directions: minting a fresh metric per tracker made cross-tracker rollup
// impossible, and demanding the user pick one first meant a boolean habit couldn't be created
// without a detour through /metrics to answer a question about canonical units. The resolution is
// that `metricMode` has three states — derive it (default), edit the six fields, or point at an
// existing metric — and the derived key is a slug of the tracker's name, which TrackersRepo reuses
// if it already exists. So two trackers named "Pushups" roll into one number, while two unrelated
// booleans stay apart.
const ZTrackerFormValues = z
  .object({
    name: z.string().min(1, "Name is required"),
    icon: z.string().nullable(),
    tileKey: z.string(),
    entryMode: z.enum(["live", "retro"]),
    scheduleType: z.enum(["daily", "days_of_week", "times_per_week", "every_n_days"]),
    scheduleDays: z.array(z.number().min(0).max(6)),
    scheduleCount: z.number().int().min(1).max(7),
    scheduleIntervalDays: z.number().int().min(2).max(365),
    target: z.string(),
    step: z.string(),
    // DEV_NOTE: always a concrete unit in form state, never null — the field has to hold an answer
    // for the Select to render one. Whether that answer is *stored* is decided on submit, by the
    // metric: a count metric writes null, because "4 minutes of pushups" is not a sentence.
    displayUnit: Schemas.ZDisplayUnit,
    // DEV_NOTE: the day the target in this form starts counting, not a property of the tracker —
    // it is written to the target history rather than to the manifest, and only when the target
    // actually changed. Edit mode only: a new tracker's first target era opens on activeFrom, which
    // is the field above it, and asking the same question twice on the create screen would suggest
    // the two can differ.
    targetEffectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    activeFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // DEV_NOTE: null = "no reminder", the default for every tracker until its owner opts in — not a
    // manifest field (see ZTrackerBase's DEV_NOTE), so it travels as its own sibling here too.
    reminderHour: z.number().int().min(0).max(23).nullable(),
    goalPublicId: z.string().nullable(),
    metricMode: z.enum(["derived", "custom", "existing"]),
    metricPublicId: z.string(),
    metricKey: z.string(),
    metricName: z.string(),
    semanticType: Schemas.ZSemanticType,
    canonicalUnit: z.string(),
    defaultAgg: Schemas.ZDefaultAgg,
    direction: Schemas.ZDirection,
    dateAttribution: Schemas.ZDateAttribution,
  })
  .superRefine((values, ctx) => {
    if (values.scheduleType === "days_of_week" && values.scheduleDays.length === 0) {
      ctx.addIssue({ code: "custom", path: ["scheduleDays"], message: "Pick at least one day" });
    }
    if (values.metricMode === "existing" && values.metricPublicId === "") {
      ctx.addIssue({ code: "custom", path: ["metricPublicId"], message: "Choose a metric" });
    }
    if (values.metricMode === "custom") {
      if (values.metricKey.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["metricKey"], message: "Key is required" });
      }
      if (values.metricName.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["metricName"], message: "Name is required" });
      }
      if (values.canonicalUnit.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["canonicalUnit"], message: "Unit is required" });
      }
    }
    if (values.target.trim() !== "" && Number.isNaN(Number(values.target))) {
      ctx.addIssue({ code: "custom", path: ["target"], message: "Target must be a number" });
    }
    if (values.step.trim() !== "" && Number.isNaN(Number(values.step))) {
      ctx.addIssue({ code: "custom", path: ["step"], message: "Step must be a number" });
    }
  });
type TrackerFormValues = z.infer<typeof ZTrackerFormValues>;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const SCHEDULE_OPTIONS: { value: TrackerFormValues["scheduleType"]; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "days_of_week", label: "Some days" },
  { value: "times_per_week", label: "N per week" },
  { value: "every_n_days", label: "Every N days" },
];

const REMINDER_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour);

// DEV_NOTE: the hour is stored and dispatched in the tracker owner's timezone (users.tz) — this
// only formats it for display, using the browser's own locale rather than a hardcoded AM/PM string.
function formatHourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// DEV_NOTE: a metric derived from an unnamed tracker still needs an addressable key — metrics are
// unique per (user_id, key) and "" is unaddressable from a manifest (MetricsCommon.ts). The form
// can't submit while the name is empty, so this only ever shows in the preview.
const UNNAMED_METRIC_KEY = "untitled_tracker";

// DEV_NOTE: no `direction` — that moved onto the manifest (ZTrackerManifest), because the same
// metric points different ways for different trackers. It's a form field of its own now, sitting
// beside the target it's scored against rather than inside the metric panel.
interface EffectiveMetric {
  key: string;
  name: string;
  semanticType: Schemas.SemanticType;
  canonicalUnit: string;
  defaultAgg: Schemas.DefaultAgg;
  dateAttribution: Schemas.DateAttribution;
}

// DEV_NOTE: one function, used by both the preview and the submit handler, so what the sidebar
// promises and what the API receives cannot drift apart.
function resolveMetric(
  values: TrackerFormValues,
  control: Schemas.Control,
  metrics: Schemas.MetricWithUsageApiShape[],
): { metric: EffectiveMetric; isExisting: boolean } {
  if (values.metricMode === "existing") {
    const chosen = metrics.find((metric) => metric.publicId === values.metricPublicId);
    if (chosen) {
      return {
        isExisting: true,
        metric: {
          key: chosen.key,
          name: chosen.name,
          semanticType: chosen.semanticType,
          canonicalUnit: chosen.canonicalUnit,
          defaultAgg: chosen.defaultAgg,
          dateAttribution: chosen.dateAttribution,
        },
      };
    }
  }

  if (values.metricMode === "custom") {
    return {
      isExisting: false,
      metric: {
        key: values.metricKey.trim() === "" ? UNNAMED_METRIC_KEY : values.metricKey.trim(),
        name: values.metricName.trim() === "" ? values.name : values.metricName.trim(),
        semanticType: values.semanticType,
        canonicalUnit: values.canonicalUnit,
        defaultAgg: values.defaultAgg,
        dateAttribution: values.dateAttribution,
      },
    };
  }

  const slug = slugifyMetricKey(values.name);
  return {
    isExisting: false,
    metric: {
      key: slug === "" ? UNNAMED_METRIC_KEY : slug,
      name: values.name.trim() === "" ? "Untitled tracker" : values.name.trim(),
      ...deriveMetricShape(control),
    },
  };
}

function buildSchedule(values: TrackerFormValues): Schemas.TrackerSchedule {
  if (values.scheduleType === "days_of_week") {
    return { type: "days_of_week", days: [...values.scheduleDays].sort((a, b) => a - b) };
  }
  if (values.scheduleType === "times_per_week") {
    return { type: "times_per_week", count: values.scheduleCount };
  }
  if (values.scheduleType === "every_n_days") {
    return { type: "every_n_days", intervalDays: values.scheduleIntervalDays };
  }
  return { type: "daily" };
}

// DEV_NOTE: the inverse of the submit handler — a stored tracker read back into the flat field
// shape. metricMode is always "existing" here because editing can't repoint the metric
// (ZUpdateTrackerApiRequest omits it): the tracker's entries already point at that metric, so the
// panel shows which one it writes rather than offering to change it.
function valuesFromTracker(tracker: Schemas.TrackerApiShape): TrackerFormValues {
  const { manifest } = tracker;
  const tile =
    CONTROL_TILES.find(
      (option) => option.control === manifest.control && option.compute === manifest.compute,
    ) ?? CONTROL_TILES[0];
  const primary = tracker.metricDetails.find((detail) => detail.key === tracker.primaryMetricKey);

  // DEV_NOTE: a manifest written before displayUnit existed reads as "seconds", which is the
  // identity conversion — the stored target comes back into the field exactly as it went in, so
  // opening the edit screen on an old tracker and saving it changes no number. The unit is only
  // honoured for a metric that has one, so a stale value on a count metric converts nothing.
  const seededUnit =
    primary && supportsDisplayUnit(primary.semanticType)
      ? (manifest.displayUnit ?? "seconds")
      : null;

  return {
    name: tracker.name,
    icon: tracker.icon ?? null,
    tileKey: tile.key,
    entryMode: manifest.entryMode,
    scheduleType: manifest.schedule.type,
    // DEV_NOTE: manifest_json is read back with a cast, not a parse (TrackersDAL), so a row written
    // before `days` was required on this branch — or corrupted by hand — can carry no array here.
    // Falling back to [] keeps the day-tile grid (which calls .includes/.filter on this value)
    // from crashing on an old tracker instead of surfacing that as a schedule with no days picked.
    scheduleDays:
      manifest.schedule.type === "days_of_week" && Array.isArray(manifest.schedule.days)
        ? manifest.schedule.days
        : [],
    scheduleCount: manifest.schedule.type === "times_per_week" ? manifest.schedule.count : 3,
    scheduleIntervalDays:
      manifest.schedule.type === "every_n_days" &&
      typeof manifest.schedule.intervalDays === "number"
        ? manifest.schedule.intervalDays
        : 2,
    target: manifest.target === null ? "" : String(toDisplay(manifest.target, seededUnit)),
    // DEV_NOTE: step converts alongside target because it is the same kind of number — a stepper on
    // a duration metric moves by a quantity the user typed, and leaving one of the two in canonical
    // seconds while the other is in minutes is the exact confusion this field exists to end.
    step: manifest.step === null ? "" : String(toDisplay(manifest.step, seededUnit)),
    displayUnit: manifest.displayUnit ?? "seconds",
    // Today, because the common edit is "from now on I'm aiming for this". Backdating is a
    // deliberate act, so it starts from the answer that needs no thought.
    targetEffectiveFrom: getTodayLocalDate(),
    // DEV_NOTE: a stored manifest always carries a resolved direction (the Repo resolves null to
    // the metric's default on write). The fallback covers a manifest written before the field
    // existed, in the window before migration 0004 has run against the row.
    direction: manifest.direction ?? primary?.defaultDirection ?? "higher_better",
    activeFrom: tracker.activeFrom,
    reminderHour: tracker.reminderHour ?? null,
    goalPublicId: tracker.goalPublicId,
    metricMode: "existing",
    metricPublicId: tracker.primaryMetricPublicId,
    metricKey: tracker.primaryMetricKey,
    metricName: primary?.name ?? tracker.name,
    // DEV_NOTE: the derived shape is a fallback only — resolveMetric reads the real six fields off
    // the fetched /metrics row for mode "existing", and these are what the preview renders in the
    // moment before that request lands.
    ...deriveMetricShape(manifest.control),
    ...(primary
      ? { semanticType: primary.semanticType, canonicalUnit: primary.canonicalUnit }
      : {}),
  };
}

interface TrackerFormProps {
  // DEV_NOTE: `meta` carries what isn't part of a tracker's stored shape — today, the day the
  // target in this submission starts counting, which the edit screen forwards to the target
  // history and the create screen ignores (a new tracker's first era opens on activeFrom). Kept
  // out of the request object rather than bolted onto the manifest, because manifest_json is the
  // tracker's configuration and this is a fact about when a configuration became true.
  onSubmit: (
    value: Schemas.CreateTrackerApiRequest,
    meta: { targetEffectiveFrom: string },
  ) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  // DEV_NOTE: present = edit an existing tracker. The form still emits a full
  // CreateTrackerApiRequest either way and the edit screen narrows it to the patchable fields —
  // one submit shape, so the preview and the payload can't drift apart between the two modes.
  tracker?: Schemas.TrackerApiShape;
}

export function TrackerForm({
  onSubmit,
  onCancel,
  submitLabel = "Save",
  tracker,
}: TrackerFormProps) {
  const { getToken } = useAuth();
  const metricsQuery = useQuery(MetricsQueries.list(getToken));
  const metrics = metricsQuery.data?.metrics ?? [];
  const goalsQuery = useQuery(EntitiesQueries.list("goal", getToken));
  const goals = goalsQuery.data?.entities ?? [];

  const isEditing = tracker !== undefined;
  const [metricPanelOpen, setMetricPanelOpen] = useState(false);
  const [computePanelOpen, setComputePanelOpen] = useState(false);

  const defaultValues: TrackerFormValues = tracker
    ? valuesFromTracker(tracker)
    : {
        name: "",
        icon: null,
        tileKey: "toggle",
        entryMode: "retro",
        scheduleType: "daily",
        scheduleDays: [],
        scheduleCount: 3,
        scheduleIntervalDays: 2,
        target: "",
        step: "",
        // DEV_NOTE: "minutes" rather than "seconds" as the starting answer — a duration tracker is
        // a thing someone spends minutes or hours on, and seconds is the unit they'd have to
        // notice and change. It's inert until the metric is a duration, and the Select only appears
        // then, so a toggle habit never sees it.
        displayUnit: "minutes",
        direction: deriveDirection("toggle"),
        targetEffectiveFrom: getTodayLocalDate(),
        activeFrom: getTodayLocalDate(),
        reminderHour: null,
        goalPublicId: null,
        metricMode: "derived",
        metricPublicId: "",
        metricKey: "",
        metricName: "",
        ...deriveMetricShape("toggle"),
      };

  const form = useForm({
    defaultValues,
    validators: { onSubmit: ZTrackerFormValues },
    onSubmit: async ({ value }) => {
      const tile = CONTROL_TILES.find((option) => option.key === value.tileKey) ?? CONTROL_TILES[0];
      const { metric, isExisting } = resolveMetric(value, tile.control, metrics);

      // DEV_NOTE: the metric decides whether the form's unit is real, not the form — a user who
      // picked "minutes" and then repointed the tracker at a count metric must not store a unit
      // that would silently multiply every future entry by 60.
      const displayUnit = supportsDisplayUnit(metric.semanticType) ? value.displayUnit : null;

      const metricSpec: Schemas.TrackerMetricSpec = isExisting
        ? { mode: "existing", metricPublicId: value.metricPublicId }
        : // DEV_NOTE: a newly declared metric is always born higher_better. The direction this
          // tracker scores by lives in its manifest below; the metric's copy is only what a
          // *future* tracker inherits, and "more is better" is the honest default for a measure
          // nobody has yet said anything about.
          { mode: "new", metric: { ...metric, defaultDirection: "higher_better" } };

      await onSubmit(
        {
          tracker: {
            name: value.name.trim(),
            icon: value.icon,
            manifest: {
              control: tile.control,
              // DEV_NOTE: the primary metric's key is added server-side — the Repo owns that
              // invariant so it holds for every caller, not just this form.
              metrics: [],
              // DEV_NOTE: converted here and nowhere else on the way out — the API, the DB and every
              // aggregate that reads them hold canonical units only (invariant 2). `displayUnit`
              // travels beside them so the same numbers can be read back in the unit they were typed.
              target:
                value.target.trim() === "" ? null : toCanonical(Number(value.target), displayUnit),
              step: value.step.trim() === "" ? null : toCanonical(Number(value.step), displayUnit),
              direction: value.direction,
              entryMode: value.entryMode,
              schedule: buildSchedule(value),
              compute: tile.compute,
              displayUnit,
            },
            activeFrom: value.activeFrom,
            reminderHour: value.reminderHour,
            goalPublicId: value.goalPublicId,
          },
          metric: metricSpec,
        },
        { targetEffectiveFrom: value.targetEffectiveFrom },
      );
    },
  });

  // DEV_NOTE: picking a tile rewrites the derived metric fields, because they are the control's
  // consequence rather than a parallel choice. It deliberately leaves a custom or existing metric
  // alone — a user who opened Change and typed a unit has overridden the derivation on purpose.
  function applyTile(tileKey: string) {
    const tile = CONTROL_TILES.find((option) => option.key === tileKey);
    if (!tile) return;

    const previous = CONTROL_TILES.find((option) => option.key === form.getFieldValue("tileKey"));
    form.setFieldValue("tileKey", tileKey);

    // DEV_NOTE: direction follows the tile only while it still holds the previous tile's suggestion
    // — an amount pad starts as a cap and a timer as a floor. Once the user has answered the
    // question themselves, switching tiles must not silently un-answer it.
    if (previous && form.getFieldValue("direction") === deriveDirection(previous.control)) {
      form.setFieldValue("direction", deriveDirection(tile.control));
    }

    if (form.getFieldValue("metricMode") === "derived") {
      const shape = deriveMetricShape(tile.control);
      form.setFieldValue("semanticType", shape.semanticType);
      form.setFieldValue("canonicalUnit", shape.canonicalUnit);
      form.setFieldValue("defaultAgg", shape.defaultAgg);
      form.setFieldValue("dateAttribution", shape.dateAttribution);
    }
  }

  // DEV_NOTE: pointing at an existing metric seeds the direction from that metric's default, which
  // is the whole reason the default survived on the metric — "money_expense_amount" already knows
  // it's usually a cap, so a second spending tracker doesn't have to be told again.
  function applyExistingMetric(metricPublicId: string) {
    form.setFieldValue("metricPublicId", metricPublicId);
    const chosen = metrics.find((metric) => metric.publicId === metricPublicId);
    if (chosen) form.setFieldValue("direction", chosen.defaultDirection);
  }

  // DEV_NOTE: five semantic types name their own unit (UNIT_FOR_SEMANTIC_TYPE) — picking one writes
  // it and the unit field goes read-only. Without this the form happily stored a
  // `duration_seconds` metric whose canonical unit was "count", which is a value nothing downstream
  // can interpret.
  function applySemanticType(semanticType: Schemas.SemanticType) {
    form.setFieldValue("semanticType", semanticType);
    const implied = UNIT_FOR_SEMANTIC_TYPE[semanticType];
    form.setFieldValue("canonicalUnit", implied ?? "");
  }

  // DEV_NOTE: opening Change seeds the editable fields from whatever the derivation produced, so
  // the panel starts as a description of the current state rather than an empty form the user has
  // to fill in from scratch to change one field.
  function openMetricPanel() {
    const values = form.state.values;
    const tile = CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];

    if (values.metricMode === "derived") {
      const { metric } = resolveMetric(values, tile.control, metrics);
      form.setFieldValue("metricMode", "custom");
      form.setFieldValue("metricKey", metric.key);
      form.setFieldValue("metricName", metric.name);
    }
    setMetricPanelOpen(true);
  }

  function resetMetricToDerived() {
    const values = form.state.values;
    const tile = CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
    const shape = deriveMetricShape(tile.control);

    form.setFieldValue("metricMode", "derived");
    form.setFieldValue("metricPublicId", "");
    form.setFieldValue("metricKey", "");
    form.setFieldValue("metricName", "");
    form.setFieldValue("semanticType", shape.semanticType);
    form.setFieldValue("canonicalUnit", shape.canonicalUnit);
    form.setFieldValue("defaultAgg", shape.defaultAgg);
    form.setFieldValue("dateAttribution", shape.dateAttribution);
    setMetricPanelOpen(false);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
      className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="flex flex-col border-border lg:border-r">
        <header className="px-6 py-8">
          <h1 className="font-heading text-3xl font-semibold">
            {isEditing ? "Edit tracker" : "New tracker"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isEditing
              ? "Rename it, retarget it, reschedule it. The control and metric stay fixed — everything already logged was written through them."
              : "Name it and pick how you’ll log it. Everything else has a sane default."}
          </p>
        </header>

        {/* 1 — what is it */}
        <SectionHeading index={1} title="What is it" />
        <div className="grid grid-cols-1 border-b border-border sm:grid-cols-[minmax(0,1fr)_160px]">
          <form.Field name="name">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <div className="flex flex-col gap-2 px-6 py-5 sm:border-r sm:border-border">
                  <FieldLabelText htmlFor={field.name}>Name</FieldLabelText>
                  <Input
                    id={field.name}
                    autoFocus
                    placeholder="Take a bath"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    aria-invalid={isInvalid}
                    className={UNDERLINE_INPUT}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>

          <form.Field name="icon">
            {(field) => (
              <div className="flex flex-col gap-2 px-6 py-5">
                <FieldLabelText>Icon</FieldLabelText>
                <IconPicker value={field.state.value} onChange={field.handleChange} />
              </div>
            )}
          </form.Field>
        </div>

        {/* 2 — how you log it */}
        <SectionHeading index={2} title="How you log it" />
        <div className="border-b border-border px-6 py-5">
          <FieldLabelText>Control</FieldLabelText>
          <form.Subscribe selector={(state) => state.values.tileKey}>
            {(tileKey) => (
              <div className="mt-3 grid grid-cols-2 border-t border-l border-border sm:grid-cols-4">
                {CONTROL_TILES.map((tile) => {
                  const selected = tileKey === tile.key;
                  return (
                    <button
                      key={tile.key}
                      type="button"
                      aria-pressed={selected}
                      disabled={isEditing}
                      onClick={() => applyTile(tile.key)}
                      className={cn(
                        "flex flex-col items-start gap-1 border-r border-b border-border px-4 py-3 text-left transition-colors",
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent hover:text-accent-foreground",
                        // DEV_NOTE: the unselected tiles fade out rather than the whole grid — the
                        // control a tracker already has is still worth reading at full contrast.
                        isEditing &&
                          !selected &&
                          "opacity-40 hover:bg-transparent hover:text-inherit",
                      )}
                    >
                      <span className="text-sm font-medium">{tile.label}</span>
                      <span
                        className={cn(
                          "text-xs",
                          selected ? "text-primary-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {tile.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </form.Subscribe>
          {isEditing ? (
            <p className="mt-3 text-xs text-muted-foreground">
              The control is fixed after creation. Every entry this tracker holds was written
              through it — a timer&rsquo;s seconds would be read as a count under any other one.
            </p>
          ) : null}
        </div>

        {/* 3 — how often */}
        <SectionHeading index={3} title="How often" />
        <div className="grid grid-cols-1 border-b border-border sm:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex flex-col gap-3 px-6 py-5 sm:border-r sm:border-border">
            <FieldLabelText>Schedule</FieldLabelText>
            <form.Field name="scheduleType">
              {(field) => (
                <div className="flex w-fit border border-border">
                  {SCHEDULE_OPTIONS.map((option) => {
                    const selected = field.state.value === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => field.handleChange(option.value)}
                        className={cn(
                          "border-r border-border px-4 py-1.5 text-sm transition-colors last:border-r-0",
                          selected
                            ? "bg-foreground font-medium text-background"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.scheduleType}>
              {(scheduleType) =>
                scheduleType === "days_of_week" ? (
                  <form.Field name="scheduleDays">
                    {(field) => {
                      // DEV_NOTE: mirrors the Array.isArray guard in valuesFromTracker — belt and
                      // braces alongside the `key` on this element (see the sibling branches below):
                      // the key stops React from reusing the previous branch's form.Field instance
                      // (scheduleCount/scheduleIntervalDays are numbers) when the schedule tile
                      // switches, but this stays as a second line of defence against any other path
                      // that hands the field a non-array snapshot.
                      const days = Array.isArray(field.state.value) ? field.state.value : [];
                      return (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap gap-1">
                            {DAY_NAMES.map((dayName, day) => {
                              const selected = days.includes(day);
                              return (
                                <button
                                  key={dayName}
                                  type="button"
                                  aria-pressed={selected}
                                  onClick={() =>
                                    field.handleChange(
                                      selected
                                        ? days.filter((value) => value !== day)
                                        : [...days, day],
                                    )
                                  }
                                  className={cn(
                                    "border px-2.5 py-1 text-xs transition-colors",
                                    selected
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                  )}
                                >
                                  {dayName}
                                </button>
                              );
                            })}
                          </div>
                          <FieldError errors={field.state.meta.errors} />
                        </div>
                      );
                    }}
                  </form.Field>
                ) : scheduleType === "times_per_week" ? (
                  <form.Field name="scheduleCount">
                    {(field) => (
                      <Input
                        type="number"
                        min="1"
                        max="7"
                        aria-label="Times per week"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.valueAsNumber)}
                        onBlur={field.handleBlur}
                        className={cn(UNDERLINE_INPUT, "w-24")}
                      />
                    )}
                  </form.Field>
                ) : scheduleType === "every_n_days" ? (
                  <form.Field name="scheduleIntervalDays">
                    {(field) => (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>Every</span>
                        <Input
                          type="number"
                          min="2"
                          max="365"
                          aria-label="Interval in days"
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.valueAsNumber)}
                          onBlur={field.handleBlur}
                          className={cn(UNDERLINE_INPUT, "w-20")}
                        />
                        <span>days</span>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </form.Field>
                ) : null
              }
            </form.Subscribe>
          </div>

          <form.Field name="activeFrom">
            {(field) => (
              <div className="flex flex-col gap-2 px-6 py-5">
                <FieldLabelText htmlFor={field.name}>Starts</FieldLabelText>
                {/* DEV_NOTE: the date input's own rendering follows the browser's locale and can't
                    be forced, so the app's reading of it ("Today · 09-09-2026") sits underneath
                    rather than replacing the control. */}
                <Input
                  id={field.name}
                  type="date"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  className={UNDERLINE_INPUT}
                />
                <span className="text-xs text-muted-foreground">
                  {formatStartDate(field.state.value)}
                </span>
              </div>
            )}
          </form.Field>
        </div>

        <div className="grid grid-cols-1 gap-5 border-b border-border px-6 py-5 sm:grid-cols-2">
          <form.Field name="reminderHour">
            {(field) => (
              <div className="flex flex-col gap-2 sm:max-w-60">
                <div className="flex items-center gap-1.5">
                  <FieldLabelText htmlFor={field.name}>Reminder</FieldLabelText>
                  <InfoHint label="Why a per-tracker reminder">
                    A push notification at this hour, in your timezone, on days this tracker asks
                    you to log — only if you haven't yet.
                  </InfoHint>
                </div>
                <Select
                  value={field.state.value === null ? "none" : String(field.state.value)}
                  onValueChange={(value) =>
                    field.handleChange(value === "none" ? null : Number(value))
                  }
                >
                  <SelectTrigger id={field.name} className={UNDERLINE_TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No reminder</SelectItem>
                      {REMINDER_HOUR_OPTIONS.map((hour) => (
                        <SelectItem key={hour} value={String(hour)}>
                          {formatHourLabel(hour)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
          </form.Field>

          <form.Field name="goalPublicId">
            {(field) => (
              <div className="flex flex-col gap-2 sm:max-w-60">
                <div className="flex items-center gap-1.5">
                  <FieldLabelText htmlFor={field.name}>Toward a goal</FieldLabelText>
                  <InfoHint label="Why link a goal">
                    The goal&apos;s page lists every tracker linked to it, so you can see what
                    you&apos;re actually doing about it.
                  </InfoHint>
                </div>
                {goalsQuery.isPending ? (
                  <span className="text-sm text-muted-foreground">Loading goals…</span>
                ) : goalsQuery.isError ? (
                  <span className="text-sm text-destructive">Failed to load goals.</span>
                ) : goals.length === 0 && field.state.value === null ? (
                  <span className="text-sm text-muted-foreground">
                    No goals yet.{" "}
                    <Link to="/entities/new" className="underline underline-offset-4">
                      Create one
                    </Link>
                  </span>
                ) : (
                  <Select
                    value={field.state.value ?? "none"}
                    onValueChange={(value) => field.handleChange(value === "none" ? null : value)}
                  >
                    <SelectTrigger id={field.name} className={UNDERLINE_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">No goal</SelectItem>
                        {goals.map((goal) => (
                          <SelectItem key={goal.publicId} value={goal.publicId}>
                            {goal.name}
                          </SelectItem>
                        ))}
                        {/* DEV_NOTE: the goal list excludes archived goals, but a tracker can still
                            point at one — without this item the trigger would render blank and
                            re-saving would look like it cleared a link it didn't. */}
                        {field.state.value !== null &&
                        !goals.some((goal) => goal.publicId === field.state.value) ? (
                          <SelectItem value={field.state.value}>Archived goal</SelectItem>
                        ) : null}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </form.Field>
        </div>

        {/* 4 — optional */}
        <SectionHeading index={4} title="Optional" />
        <div className="grid grid-cols-1 border-b border-border sm:grid-cols-2 lg:grid-cols-4">
          {/* DEV_NOTE: the unit sits inside the Target cell rather than in a fifth column, because
              it is not a fifth question — it's what the number to its left means. A target of 4
              beside a unit of "minutes" is one fact; the same two fields a column apart are two. */}
          <form.Subscribe selector={(state) => state.values}>
            {(values) => {
              const tile =
                CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
              const { metric } = resolveMetric(values, tile.control, metrics);
              const hasDisplayUnit = supportsDisplayUnit(metric.semanticType);
              const targetDisabled = !supportsTarget(metric.semanticType);

              return (
                <div className="flex flex-col gap-2 px-6 py-5 sm:border-r sm:border-border">
                  <form.Field name="target">
                    {(field) => (
                      <>
                        <div className="flex items-center gap-1.5">
                          <FieldLabelText htmlFor={field.name}>Target</FieldLabelText>
                          {targetDisabled ? (
                            <InfoHint label="Why target is disabled">
                              {BOOLEAN_TARGET_HELP}
                            </InfoHint>
                          ) : null}
                        </div>
                        <div className="flex items-end gap-2">
                          <Input
                            id={field.name}
                            type="number"
                            step="any"
                            placeholder="Not set"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onBlur={field.handleBlur}
                            disabled={targetDisabled}
                            className={cn(UNDERLINE_INPUT, hasDisplayUnit && "min-w-0 flex-1")}
                          />
                          {hasDisplayUnit ? (
                            <form.Field name="displayUnit">
                              {(unitField) => (
                                <Select
                                  value={unitField.state.value}
                                  onValueChange={(value) =>
                                    unitField.handleChange(value as Schemas.DisplayUnit)
                                  }
                                >
                                  <SelectTrigger
                                    aria-label="Unit the target and every entry are typed in"
                                    className={cn(UNDERLINE_TRIGGER, "w-28 shrink-0")}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {Schemas.ZDisplayUnit.options.map((option) => (
                                        <SelectItem key={option} value={option}>
                                          {DISPLAY_UNIT_LABELS[option]}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              )}
                            </form.Field>
                          ) : null}
                        </div>
                        {hasDisplayUnit ? (
                          <span className="text-xs text-muted-foreground">
                            What you type here and on every entry. Stored as seconds either way, so
                            changing it re-reads your history rather than rewriting it.
                          </span>
                        ) : null}
                        <FieldError errors={field.state.meta.errors} />
                      </>
                    )}
                  </form.Field>

                  {/* DEV_NOTE: only when editing, and only when the number above actually changed —
                      a date asking "from when?" beside a target nobody touched is a question about
                      nothing, and answering it would write an era identical to the one before it.
                      Days before this date keep the target they were lived under; that is the whole
                      point, and it's why the hint says so rather than leaving it to be discovered.  */}
                  {isEditing && tracker !== undefined ? (
                    <form.Subscribe
                      selector={(state) => [state.values.target, state.values.displayUnit] as const}
                    >
                      {([typedTarget, typedUnit]) => {
                        const unit = hasDisplayUnit ? typedUnit : null;
                        const submitted =
                          typedTarget.trim() === "" || Number.isNaN(Number(typedTarget))
                            ? null
                            : toCanonical(Number(typedTarget), unit);
                        if (submitted === tracker.manifest.target) return null;

                        return (
                          <form.Field name="targetEffectiveFrom">
                            {(dateField) => (
                              <div className="mt-4 flex flex-col gap-2">
                                <FieldLabelText htmlFor={dateField.name}>
                                  New target applies from
                                </FieldLabelText>
                                <Input
                                  id={dateField.name}
                                  type="date"
                                  value={dateField.state.value}
                                  onChange={(event) => dateField.handleChange(event.target.value)}
                                  onBlur={dateField.handleBlur}
                                  className={UNDERLINE_INPUT}
                                />
                                <span className="text-xs text-muted-foreground">
                                  Days before this keep the target they were logged under. Backdate
                                  it if you adopted this goal earlier than today.
                                </span>
                                <FieldError errors={dateField.state.meta.errors} />
                              </div>
                            )}
                          </form.Field>
                        );
                      }}
                    </form.Subscribe>
                  ) : null}
                </div>
              );
            }}
          </form.Subscribe>

          {/* DEV_NOTE: next to Target on purpose — the two are one question ("is this number a
              floor or a ceiling?"), and the backend scores a day by reading them together. */}
          <form.Subscribe selector={(state) => state.values}>
            {(values) => {
              const tile =
                CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
              const { metric } = resolveMetric(values, tile.control, metrics);
              const targetDisabled = !supportsTarget(metric.semanticType);

              return (
                <form.Field name="direction">
                  {(field) => (
                    <div className="flex flex-col gap-2 px-6 py-5 lg:border-r lg:border-border">
                      <div className="flex items-center gap-1.5">
                        <FieldLabelText htmlFor={field.name}>Direction</FieldLabelText>
                        <InfoHint
                          label={
                            targetDisabled
                              ? "Why direction is disabled"
                              : "Why direction is set per tracker"
                          }
                        >
                          {targetDisabled ? BOOLEAN_TARGET_HELP : DIRECTION_HELP}
                        </InfoHint>
                      </div>
                      <Select
                        value={field.state.value}
                        onValueChange={(value) => field.handleChange(value as Schemas.Direction)}
                        disabled={targetDisabled}
                      >
                        <SelectTrigger id={field.name} className={UNDERLINE_TRIGGER}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {Schemas.ZDirection.options.map((option) => (
                              <SelectItem key={option} value={option}>
                                {DIRECTION_LABELS[option]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">
                        {DIRECTION_HINTS[field.state.value]}
                      </span>
                    </div>
                  )}
                </form.Field>
              );
            }}
          </form.Subscribe>

          <form.Subscribe selector={(state) => state.values}>
            {(values) => {
              const tile =
                CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
              const { metric } = resolveMetric(values, tile.control, metrics);
              const targetDisabled = !supportsTarget(metric.semanticType);

              return (
                <form.Field name="step">
                  {(field) => (
                    <div className="flex flex-col gap-2 px-6 py-5 sm:border-r sm:border-border">
                      <div className="flex items-center gap-1.5">
                        <FieldLabelText htmlFor={field.name}>Step</FieldLabelText>
                        {targetDisabled ? (
                          <InfoHint label="Why step is disabled">{BOOLEAN_TARGET_HELP}</InfoHint>
                        ) : null}
                      </div>
                      <Input
                        id={field.name}
                        type="number"
                        step="any"
                        placeholder="Not set"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onBlur={field.handleBlur}
                        disabled={targetDisabled}
                        className={UNDERLINE_INPUT}
                      />
                      {/* DEV_NOTE: step is typed in the same unit as the target — it's the amount one
                          tap moves, and a stepper whose target is in minutes while its step is in
                          seconds would move by a 60th of what the number says. */}
                      {supportsDisplayUnit(metric.semanticType) ? (
                        <span className="text-xs text-muted-foreground">
                          In {DISPLAY_UNIT_LABELS[values.displayUnit]}, same as the target.
                        </span>
                      ) : null}
                      <FieldError errors={field.state.meta.errors} />
                    </div>
                  )}
                </form.Field>
              );
            }}
          </form.Subscribe>

          <form.Field name="entryMode">
            {(field) => (
              <div className="flex flex-col gap-2 px-6 py-5">
                <FieldLabelText htmlFor={field.name}>Entry mode</FieldLabelText>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => field.handleChange(value as "live" | "retro")}
                >
                  <SelectTrigger id={field.name} className={UNDERLINE_TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="retro">Any date</SelectItem>
                      <SelectItem value="live">Today only</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
          </form.Field>
        </div>

        {/* Metric & units — derived, with every field one press away */}
        <form.Subscribe selector={(state) => state.values}>
          {(values) => {
            const tile =
              CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
            const { metric, isExisting } = resolveMetric(values, tile.control, metrics);

            return (
              <div className="border-b border-border">
                <div className="flex items-center justify-between gap-4 px-6 py-5">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Metric &amp; units</span>
                    <span className="text-xs text-muted-foreground">
                      {metric.semanticType} · {metric.canonicalUnit} · {metric.defaultAgg} —{" "}
                      {isEditing
                        ? `writes into ${metric.key}, fixed after creation`
                        : isExisting
                          ? `writes into ${metric.key}`
                          : "declared automatically from the control"}
                    </span>
                  </div>
                  {/* DEV_NOTE: no Change in edit mode — repointing the metric would detach every
                      entry already written from this tracker's heatmap and streak, so the API
                      doesn't accept it (ZUpdateTrackerApiRequest) and the form doesn't offer it.
                      A metric's own six fields are still editable on the /metrics screen. */}
                  {isEditing ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 tracking-wider uppercase"
                      onClick={() =>
                        metricPanelOpen ? setMetricPanelOpen(false) : openMetricPanel()
                      }
                    >
                      {metricPanelOpen ? "Done" : "Change"}
                    </Button>
                  )}
                </div>

                {metricPanelOpen ? (
                  <div className="flex flex-col gap-5 border-t border-border bg-muted/30 px-6 py-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ModeButton
                        selected={values.metricMode === "custom"}
                        onClick={() => form.setFieldValue("metricMode", "custom")}
                      >
                        Declare a new metric
                      </ModeButton>
                      <ModeButton
                        selected={values.metricMode === "existing"}
                        onClick={() => form.setFieldValue("metricMode", "existing")}
                      >
                        Point at an existing one
                      </ModeButton>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={resetMetricToDerived}
                        className="text-muted-foreground"
                      >
                        Reset to derived
                      </Button>
                    </div>

                    {values.metricMode === "existing" ? (
                      <form.Field name="metricPublicId">
                        {(field) => {
                          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                          return (
                            <div className="flex flex-col gap-2">
                              <FieldLabelText htmlFor={field.name}>Existing metric</FieldLabelText>
                              {metricsQuery.isPending ? (
                                <p className="text-sm text-muted-foreground">Loading metrics...</p>
                              ) : metricsQuery.isError ? (
                                <p className="text-sm text-destructive">Failed to load metrics.</p>
                              ) : metrics.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                  No metrics defined yet — this tracker will have to declare one.
                                </p>
                              ) : (
                                <Select
                                  value={field.state.value}
                                  onValueChange={applyExistingMetric}
                                >
                                  <SelectTrigger
                                    id={field.name}
                                    aria-invalid={isInvalid}
                                    className="w-full"
                                  >
                                    <SelectValue placeholder="Choose a metric" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectLabel>Your metrics</SelectLabel>
                                      {metrics.map((option) => (
                                        <SelectItem key={option.publicId} value={option.publicId}>
                                          {option.name} · {option.canonicalUnit}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Two trackers on one metric roll into a single number.
                              </p>
                              <FieldError errors={field.state.meta.errors} />
                            </div>
                          );
                        }}
                      </form.Field>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <form.Field name="metricKey">
                          {(field) => (
                            <div className="flex flex-col gap-2">
                              <FieldLabelText htmlFor={field.name}>Metric key</FieldLabelText>
                              <Input
                                id={field.name}
                                value={field.state.value}
                                onChange={(event) =>
                                  field.handleChange(slugifyMetricKey(event.target.value))
                                }
                                onBlur={field.handleBlur}
                                className="font-mono"
                              />
                              <p className="text-xs text-muted-foreground">
                                A key you already own is reused, not duplicated.
                              </p>
                              <FieldError errors={field.state.meta.errors} />
                            </div>
                          )}
                        </form.Field>

                        <form.Field name="metricName">
                          {(field) => (
                            <div className="flex flex-col gap-2">
                              <FieldLabelText htmlFor={field.name}>Metric name</FieldLabelText>
                              <Input
                                id={field.name}
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                              />
                              <FieldError errors={field.state.meta.errors} />
                            </div>
                          )}
                        </form.Field>

                        <form.Field name="semanticType">
                          {(field) => (
                            <div className="flex flex-col gap-2">
                              <FieldLabelText htmlFor={field.name}>Semantic type</FieldLabelText>
                              <Select
                                value={field.state.value}
                                onValueChange={(value) =>
                                  applySemanticType(value as Schemas.SemanticType)
                                }
                              >
                                <SelectTrigger id={field.name} className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {Schemas.ZSemanticType.options.map((option) => (
                                      <SelectItem key={option} value={option}>
                                        {option}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </form.Field>

                        <form.Field name="canonicalUnit">
                          {(field) => {
                            const implied = UNIT_FOR_SEMANTIC_TYPE[values.semanticType];
                            return (
                              <div className="flex flex-col gap-2">
                                <FieldLabelText htmlFor={field.name}>Canonical unit</FieldLabelText>
                                <Input
                                  id={field.name}
                                  value={field.state.value}
                                  disabled={implied !== undefined}
                                  placeholder={UNIT_PLACEHOLDER[values.semanticType]}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                  onBlur={field.handleBlur}
                                />
                                <p className="text-xs text-muted-foreground">
                                  {implied
                                    ? `${values.semanticType} is always measured in ${implied}.`
                                    : "What one unit of this metric is. Stored as typed — display units are converted on the way out."}
                                </p>
                                <FieldError errors={field.state.meta.errors} />
                              </div>
                            );
                          }}
                        </form.Field>

                        <form.Field name="defaultAgg">
                          {(field) => (
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-1.5">
                                <FieldLabelText htmlFor={field.name}>Aggregation</FieldLabelText>
                                <InfoHint label="Why aggregation belongs to the metric">
                                  {AGG_HELP}
                                </InfoHint>
                              </div>
                              <Select
                                value={field.state.value}
                                onValueChange={(value) =>
                                  field.handleChange(value as Schemas.DefaultAgg)
                                }
                              >
                                <SelectTrigger id={field.name} className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {Schemas.ZDefaultAgg.options.map((option) => (
                                      <SelectItem key={option} value={option}>
                                        {AGG_LABELS[option]}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-muted-foreground">
                                {AGG_HINTS[field.state.value]}
                              </p>
                            </div>
                          )}
                        </form.Field>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }}
        </form.Subscribe>

        {/* Compute module — read-only, because the tile decides it */}
        <form.Subscribe selector={(state) => state.values.tileKey}>
          {(tileKey) => {
            const tile = CONTROL_TILES.find((option) => option.key === tileKey) ?? CONTROL_TILES[0];
            return (
              <div className="border-b border-border">
                <div className="flex items-center justify-between gap-4 px-6 py-5">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Compute module</span>
                    <span className="text-xs text-muted-foreground">
                      {tile.compute
                        ? `${tile.compute} — the transfer tile brings its own.`
                        : "None. Only money transfers need one today."}
                    </span>
                  </div>
                  {/* DEV_NOTE: the panel's only content is "pick the Transfer tile", and the tiles
                      are locked in edit mode — so there is nothing here to open. */}
                  {isEditing ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 tracking-wider uppercase"
                      onClick={() => setComputePanelOpen((open) => !open)}
                    >
                      {computePanelOpen ? "Done" : "Change"}
                    </Button>
                  )}
                </div>

                {computePanelOpen ? (
                  // DEV_NOTE: not a picker. A compute module is bound to the shape it computes —
                  // money.transfer.v1 writes two signed entries sharing a transfer_group_id, which
                  // only makes sense under an amount pad. Picking one independently of the control
                  // would let a user build a tracker the backend rejects at create time
                  // (validateComputeManifest), so the tile is the only way in and this panel just
                  // says so.
                  <div className="border-t border-border bg-muted/30 px-6 py-5">
                    <p className="text-sm text-muted-foreground">
                      Compute modules follow the control. Pick the{" "}
                      <button
                        type="button"
                        onClick={() => {
                          applyTile("transfer");
                          setComputePanelOpen(false);
                        }}
                        className="text-foreground underline underline-offset-2"
                      >
                        Transfer
                      </button>{" "}
                      tile above to get money.transfer.v1 — the one thing the eight controls
                      can&rsquo;t express on their own. Every other tracker needs none.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          }}
        </form.Subscribe>

        <div className="flex justify-end gap-2 px-6 py-5">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              form.reset();
              onCancel();
            }}
          >
            Cancel
          </Button>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : submitLabel}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </div>

      <aside className="border-t border-border lg:sticky lg:top-0 lg:h-fit lg:border-t-0">
        <form.Subscribe selector={(state) => state.values}>
          {(values) => {
            const tile =
              CONTROL_TILES.find((option) => option.key === values.tileKey) ?? CONTROL_TILES[0];
            const { metric, isExisting } = resolveMetric(values, tile.control, metrics);

            return (
              <TrackerPreview
                name={values.name}
                icon={values.icon}
                control={tile.control}
                schedule={buildSchedule(values)}
                direction={values.direction}
                metric={metric}
                isExistingMetric={isExisting}
              />
            );
          }}
        </form.Subscribe>
      </aside>
    </form>
  );
}

// DEV_NOTE: shadcn's Input is used as-is and reshaped through className (never edited in
// src/shadcn/ui/) — the design's fields are a single rule under the text rather than a boxed input.
const UNDERLINE_INPUT =
  "rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus-visible:border-primary focus-visible:ring-0 dark:bg-transparent";

const UNDERLINE_TRIGGER =
  "w-full rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus-visible:border-primary focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent";

function SectionHeading({ index, title }: { index: number; title: string }) {
  return (
    <div className="border-b border-border px-6 py-2.5">
      <p className="text-2xs font-medium tracking-widest text-muted-foreground uppercase">
        {index} · {title}
      </p>
    </div>
  );
}

function FieldLabelText({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-2xs font-medium tracking-widest text-muted-foreground uppercase"
    >
      {children}
    </label>
  );
}

function ModeButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "border px-3 py-1.5 text-xs transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
