import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import worker from "../index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const mockAuthenticateRequest = vi.fn().mockResolvedValue({
  isSignedIn: true,
  reason: null,
  toAuth: () => ({
    userId: "user_test123",
    sessionClaims: { email: "test@example.com" },
  }),
});

vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: mockAuthenticateRequest,
    }),
  },
}));

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

const testEnv = { ...env, APP_ENV: "staging" as const };

function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const today = new Date().toISOString().slice(0, 10);

// DEV_NOTE: Time after the manifest engine — one tracker row with the timer control. Start/stop are
// two members of the same quick-add payload, not two bespoke endpoints, and the duration reading is
// still appended only on stop (a running session contributes nothing to any aggregate).
const TIME_MANIFEST = {
  control: "timer" as const,
  metrics: [] as string[],
  target: null,
  step: null,
  direction: null,
  entryMode: "live" as const,
  schedule: { type: "daily" as const },
  compute: null,
};

const durationMetric = {
  mode: "new" as const,
  metric: {
    key: "time_duration_seconds",
    name: "Duration",
    semanticType: "duration_seconds" as const,
    canonicalUnit: "seconds",
    defaultAgg: "sum" as const,
    defaultDirection: "neutral" as const,
    dateAttribution: "start" as const,
  },
};

async function createTimeTracker(name: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/trackers", "POST", {
      tracker: { name, manifest: TIME_MANIFEST, activeFrom: today },
      metric: durationMetric,
    }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { tracker: { publicId: string } };
  return body.tracker.publicId;
}

function startTimer(trackerPublicId: string, label: string, entityLinks: unknown[] = []) {
  return worker.fetch(
    makeRequest(`/trackers/${trackerPublicId}/entries`, "POST", {
      payload: { control: "timer", timer: { action: "start", label, entityLinks } },
    }),
    testEnv,
    createExecutionContext(),
  );
}

function stopTimer(trackerPublicId: string, entryPublicId: string) {
  return worker.fetch(
    makeRequest(`/trackers/${trackerPublicId}/entries`, "POST", {
      payload: { control: "timer", timer: { action: "stop", entryPublicId } },
    }),
    testEnv,
    createExecutionContext(),
  );
}

describe("Time as a manifest tracker (authenticated)", () => {
  let trackerPublicId: string;

  beforeAll(async () => {
    trackerPublicId = await createTimeTracker("Time");

    // DEV_NOTE: D1 here is `remote: true` (see vitest.config.mts) — a real, persistent database
    // shared across test runs, not reset per-run. A previous run whose stop response was eaten by
    // the remote proxy's flakiness can leave an open session behind, which would make this run's
    // first start fail. Drain first, and tolerate the check itself failing transiently.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const runningRes = await worker.fetch(
          makeRequest(`/trackers/${trackerPublicId}/running`),
          testEnv,
          createExecutionContext(),
        );
        const running = (await runningRes.json()) as {
          isSuccess: boolean;
          session?: { publicId: string } | null;
        };
        if (!running.isSuccess) continue;
        if (!running.session) break;
        await stopTimer(trackerPublicId, running.session.publicId);
      } catch {
        // retry
      }
    }
  });

  afterAll(async () => {
    await worker.fetch(
      makeRequest(`/trackers/${trackerPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
  });

  it("starting a timer then stopping it produces one closed interval entry", async () => {
    const startRes = await startTimer(trackerPublicId, "Deep work");
    expect(startRes.status).toBe(201);

    const started = (await startRes.json()) as {
      entry: { publicId: string; label: string; occurredAt: string; endedAt: string | null };
    };

    // DEV_NOTE: the finally block is a safety net, not the real assertions below — it guarantees
    // this session ends up stopped even if an assertion throws mid-test, so a failed run can't
    // strand an open session that makes the *next* run's start fail. It's a no-op if the test's own
    // stop call already succeeded (updateEntryEndedAt's ended_at IS NULL guard makes a second close
    // attempt harmlessly "not found").
    try {
      expect(started.entry.publicId).toEqual(expect.any(String));
      expect(started.entry.label).toBe("Deep work");
      expect(started.entry.endedAt).toBeNull();

      const runningRes = await worker.fetch(
        makeRequest(`/trackers/${trackerPublicId}/running`),
        testEnv,
        createExecutionContext(),
      );
      const running = (await runningRes.json()) as { session?: { publicId: string } | null };
      expect(running.session?.publicId).toBe(started.entry.publicId);

      const startAgainRes = await startTimer(trackerPublicId, "Another task");
      expect(startAgainRes.status).toBe(400);

      const stopRes = await stopTimer(trackerPublicId, started.entry.publicId);
      const stopped = (await stopRes.json()) as {
        isSuccess: boolean;
        entry: {
          publicId: string;
          occurredAt: string;
          endedAt: string | null;
          durationSeconds: number | null;
        };
      };
      expect(stopRes.status).toBe(201);
      expect(stopped.isSuccess).toBe(true);
      expect(stopped.entry.publicId).toBe(started.entry.publicId);
      expect(stopped.entry.endedAt).not.toBeNull();
      expect(stopped.entry.occurredAt).toBe(started.entry.occurredAt);
      expect(stopped.entry.durationSeconds).toBeGreaterThanOrEqual(0);

      const runningAfterStopRes = await worker.fetch(
        makeRequest(`/trackers/${trackerPublicId}/running`),
        testEnv,
        createExecutionContext(),
      );
      const runningAfterStop = (await runningAfterStopRes.json()) as { session?: unknown };
      expect(runningAfterStop.session).toBeNull();

      const stopAgainRes = await stopTimer(trackerPublicId, started.entry.publicId);
      expect(stopAgainRes.status).toBe(400);
    } finally {
      await stopTimer(trackerPublicId, started.entry.publicId);
    }
  });
});

describe("Time breakdown (authenticated)", () => {
  let ctx: ExecutionContext;
  let trackerPublicId: string;
  let personPublicId: string;

  // DEV_NOTE: D1 here is `remote: true` — a real, persistent database, not reset between runs.
  // Fixed labels would accumulate sessions across every past run, making an exact entryCount
  // assertion flaky. A run-unique suffix scopes each run's assertions to sessions it created itself.
  const runSuffix = Math.random().toString(36).slice(2, 8);
  const writingLabel = `Writing-${runSuffix}`;
  const readingLabel = `Reading-${runSuffix}`;

  beforeAll(async () => {
    trackerPublicId = await createTimeTracker(`Time Breakdown ${runSuffix}`);

    const personRes = await worker.fetch(
      makeRequest("/entities", "POST", {
        entity: { name: `Coauthor-${runSuffix}`, kind: "person" },
      }),
      testEnv,
      createExecutionContext(),
    );
    const person = (await personRes.json()) as { entity: { publicId: string } };
    personPublicId = person.entity.publicId;

    for (const label of [writingLabel, writingLabel, readingLabel]) {
      const startRes = await startTimer(trackerPublicId, label, [
        { entityPublicId: personPublicId, role: "person" },
      ]);
      const started = (await startRes.json()) as { entry: { publicId: string } };
      await stopTimer(trackerPublicId, started.entry.publicId);
    }
    // DEV_NOTE: this hook is eight remote round trips (tracker + person + three start/stop pairs),
    // and each stop fans out across entries/entry_values/daily_facts — it outgrew the config's
    // 30s hookTimeout. Widened here rather than globally, so a genuinely hung hook elsewhere still
    // fails fast.
  }, 120_000);

  afterAll(async () => {
    await worker.fetch(
      makeRequest(`/entities/${personPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
    await worker.fetch(
      makeRequest(`/trackers/${trackerPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
  });

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  it("returns per-label entry counts and summed duration, sliced by one role", async () => {
    const res = await worker.fetch(
      makeRequest(`/trackers/${trackerPublicId}/breakdown?from=${today}&to=${today}&role=person`),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rows: {
        label: string | null;
        entityPublicId: string | null;
        entryCount: number;
        total: number;
      }[];
    };
    const writing = body.rows.find((row) => row.label === writingLabel);
    const reading = body.rows.find((row) => row.label === readingLabel);

    expect(writing?.entryCount).toBe(2);
    expect(reading?.entryCount).toBe(1);
    expect(writing?.entityPublicId).toBe(personPublicId);
    expect(writing?.total).toBeGreaterThanOrEqual(0);
  });

  it("groups by label alone when no role is given", async () => {
    const res = await worker.fetch(
      makeRequest(`/trackers/${trackerPublicId}/breakdown?from=${today}&to=${today}`),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rows: { label: string | null; entityPublicId: string | null; entryCount: number }[];
    };
    const writingRows = body.rows.filter((row) => row.label === writingLabel);

    expect(writingRows).toHaveLength(1);
    expect(writingRows[0].entryCount).toBe(2);
    expect(writingRows[0].entityPublicId).toBeNull();
  });
});

describe("Unauthenticated requests", () => {
  it("GET /trackers/:publicId/running without auth returns 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      isSignedIn: false,
      reason: "no-token",
      toAuth: () => null,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(makeRequest("/trackers/trk_none/running"), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
