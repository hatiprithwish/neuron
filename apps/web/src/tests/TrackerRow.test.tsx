import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TrackerRow from "@/routes/_authenticated/trackers/-TrackerRow";
import type * as Schemas from "@app/schemas";

// Mock tanstack-router Link — renders plain anchor in jsdom
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const mockQuickAdd = vi.fn();
vi.mock("@/routes/_authenticated/trackers/-data", () => ({
  useQuickAdd: () => ({ mutate: mockQuickAdd, isPending: false }),
  useCreateTrackerMoment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// DEV_NOTE: EntityLinkFields owns five entity queries of its own — the controls that embed it
// (amount_pad, form) are exercised here for their dispatch, not their entity picker, so it's
// stubbed out lightweight instead of exercised for real.
vi.mock("@/routes/_authenticated/trackers/-EntityLinkFields", () => ({
  EntityLinkFields: () => null,
}));

// DEV_NOTE: the metric is overridable because a control and its metric are independent choices —
// the form derives one from the other, but Change lets a daily_total write a duration, which is
// exactly the combination the display-unit conversion exists for.
function makeTracker(
  control: Schemas.Control,
  manifest: Partial<Schemas.TrackerManifest> = {},
  metric: Partial<Schemas.TrackerMetricDetail> = {},
): Schemas.TrackerApiShape {
  return {
    publicId: "trk_test123",
    userId: "user_test123",
    name: "Test Tracker",
    colorIndex: null,
    goalPublicId: null,
    manifest: {
      control,
      metrics: ["test_metric"],
      target: null,
      step: null,
      direction: "higher_better",
      entryMode: "retro",
      schedule: { type: "daily" },
      compute: null,
      ...manifest,
    },
    manifestVersion: 1,
    sortOrder: 0,
    activeFrom: "2026-01-01",
    activeTo: null,
    primaryMetricPublicId: "met_test123",
    primaryMetricKey: "test_metric",
    metricDetails: [
      {
        metricPublicId: "met_test123",
        key: "test_metric",
        name: "Test Metric",
        semanticType: "count",
        canonicalUnit: "count",
        defaultDirection: "higher_better",
        ...metric,
      },
    ],
    createdAt: new Date(),
    updatedAt: null,
    archivedAt: null,
  };
}

function makeToday(
  tracker: Schemas.TrackerApiShape,
  overrides: Partial<Schemas.TrackerTodayApiShape> = {},
): Schemas.TrackerTodayApiShape {
  return {
    tracker,
    todaySum: null,
    todayCount: 0,
    streak: 0,
    isDueToday: true,
    openSession: null,
    plans: [],
    displayPlans: [],
    ...overrides,
  };
}

describe("TrackerRow", () => {
  // DEV_NOTE: the quick-add spy is module-level, and toHaveBeenCalledWith matches *any* recorded
  // call — without this, a payload assertion could be satisfied by the previous test's call.
  beforeEach(() => {
    mockQuickAdd.mockClear();
  });

  it("renders the tracker name and schedule", () => {
    render(<TrackerRow today={makeToday(makeTracker("toggle"))} />);
    expect(screen.getByText("Test Tracker")).toBeInTheDocument();
    expect(screen.getByText(/every day/i)).toBeInTheDocument();
  });

  it("shows the streak once there is one", () => {
    render(<TrackerRow today={makeToday(makeTracker("toggle"), { streak: 4 })} />);
    expect(screen.getByText(/4 day streak/i)).toBeInTheDocument();
  });

  it("shows the first if-then plan in place of the schedule", () => {
    const plan = {
      publicId: "tpl_1",
      cue: "Phone in bed",
      response: "Charge it across the room",
      isPriority: false,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: null,
    };
    render(
      <TrackerRow
        today={makeToday(makeTracker("toggle"), { plans: [plan], displayPlans: [plan] })}
      />,
    );
    expect(screen.getByText(/phone in bed/i)).toBeInTheDocument();
    expect(screen.getByText(/charge it across the room/i)).toBeInTheDocument();
    expect(screen.queryByText(/every day/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /log a trigger for test tracker/i }),
    ).toBeInTheDocument();
  });

  // DEV_NOTE: the dispatch itself is the thing worth testing — manifest.control is the only reason
  // any of these widgets appear, and getting it wrong is what a per-domain frontend used to prevent.
  it("renders the toggle control for a toggle manifest", () => {
    render(<TrackerRow today={makeToday(makeTracker("toggle"))} />);
    expect(screen.getByRole("checkbox", { name: /mark done/i })).toBeInTheDocument();
  });

  it("shows 'Done today' when the day is already logged", () => {
    render(<TrackerRow today={makeToday(makeTracker("toggle"), { todaySum: 1, todayCount: 1 })} />);
    expect(screen.getByRole("checkbox", { name: /done today/i })).toBeInTheDocument();
  });

  it("renders the stepper control with its step size", () => {
    render(<TrackerRow today={makeToday(makeTracker("stepper", { step: 2 }))} />);
    expect(screen.getByRole("button", { name: /add 2 to test tracker/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /subtract 2 from test tracker/i }),
    ).toBeInTheDocument();
  });

  it("renders the timer's start control when nothing is running", () => {
    render(<TrackerRow today={makeToday(makeTracker("timer"))} />);
    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("renders the timer's stop control for a running session", () => {
    const openSession: Schemas.TrackerEntryApiShape = {
      publicId: "eny_running",
      entryKind: "interval",
      occurredAt: new Date(),
      endedAt: null,
      durationSeconds: null,
      localDate: "2026-01-01",
      label: "Deep work",
      note: null,
      transferGroupId: null,
      values: [],
      entities: [],
      createdAt: new Date(),
    };

    render(<TrackerRow today={makeToday(makeTracker("timer"), { openSession })} />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByText(/deep work/i)).toBeInTheDocument();
  });

  // DEV_NOTE: the conversion is the whole point of manifest.displayUnit, and it is invisible in the
  // UI — a wrong factor stores a wrong number and shows a plausible one. Asserting on the payload
  // is the only place the mistake is visible.
  it("sends a duration daily total in canonical seconds, not as typed", async () => {
    const user = userEvent.setup();
    const tracker = makeTracker(
      "daily_total",
      { displayUnit: "minutes" },
      { semanticType: "duration_seconds", canonicalUnit: "seconds" },
    );

    render(<TrackerRow today={makeToday(tracker)} />);
    await user.type(screen.getByRole("spinbutton", { name: /today's total/i }), "4");
    await user.click(screen.getByRole("button", { name: /^save/i }));

    expect(mockQuickAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        publicId: "trk_test123",
        payload: expect.objectContaining({ control: "daily_total", total: 240 }),
      }),
    );
  });

  // DEV_NOTE: manifest_json has no migration behind it, so every tracker created before the field
  // existed reads it as absent. Absent has to mean "canonical", or shipping this would have
  // multiplied every existing duration tracker's next entry by 60.
  it("leaves a duration daily total untouched when no display unit is set", async () => {
    const user = userEvent.setup();
    const tracker = makeTracker(
      "daily_total",
      {},
      { semanticType: "duration_seconds", canonicalUnit: "seconds" },
    );

    render(<TrackerRow today={makeToday(tracker)} />);
    await user.type(screen.getByRole("spinbutton", { name: /today's total/i }), "4");
    await user.click(screen.getByRole("button", { name: /^save/i }));

    expect(mockQuickAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ total: 4 }),
      }),
    );
  });

  // A count metric has no second unit to be typed in, so a stale manifest value converts nothing.
  it("ignores a display unit on a metric that has none", async () => {
    const user = userEvent.setup();
    const tracker = makeTracker("daily_total", { displayUnit: "minutes" });

    render(<TrackerRow today={makeToday(tracker)} />);
    await user.type(screen.getByRole("spinbutton", { name: /today's total/i }), "4");
    await user.click(screen.getByRole("button", { name: /^save/i }));

    expect(mockQuickAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ total: 4 }),
      }),
    );
  });

  it("reads the day's total back in the metric's own terms", () => {
    const tracker = makeTracker(
      "daily_total",
      { displayUnit: "minutes" },
      { semanticType: "duration_seconds", canonicalUnit: "seconds" },
    );

    render(<TrackerRow today={makeToday(tracker, { todaySum: 165, todayCount: 1 })} />);
    expect(screen.getByText("2m 45s")).toBeInTheDocument();
  });
});
