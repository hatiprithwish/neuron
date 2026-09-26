import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import worker from "../index";

// DEV_NOTE: covers `GET /entities?withStats=true` — the Things screen's usage line. Asserted through
// the endpoint rather than against the two grouped queries, because what's under test is the
// contract (a stats row per entity, counts off entries, totals only where they combine), not the
// row layout the DAL happens to return.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TEST_USER_ID = "user_test123";

const mockAuthenticateRequest = vi.fn().mockResolvedValue({
  isSignedIn: true,
  reason: null,
  toAuth: () => ({
    userId: TEST_USER_ID,
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
const runSuffix = Math.random().toString(36).slice(2, 8);

interface StatsRow {
  entityPublicId: string;
  entryCount: number;
  lastEntryDate: string | null;
  total: { sum: number; count: number; canonicalUnit: string; defaultAgg: string } | null;
}

async function createEntity(name: string, kind: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/entities", "POST", { entity: { name, kind } }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { entity: { publicId: string } };
  return body.entity.publicId;
}

async function createTracker(name: string, key: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/trackers", "POST", {
      tracker: {
        name,
        manifest: {
          control: "increment",
          metrics: [],
          target: null,
          step: 10,
          direction: null,
          entryMode: "retro",
          schedule: { type: "daily" },
          compute: null,
        },
        activeFrom: today,
      },
      metric: {
        mode: "new",
        metric: {
          key,
          name,
          semanticType: "count",
          canonicalUnit: "count",
          defaultAgg: "sum",
          defaultDirection: "higher_better",
          dateAttribution: "start",
        },
      },
    }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { tracker: { publicId: string } };
  return body.tracker.publicId;
}

describe("Entity usage stats (GET /entities?withStats=true)", () => {
  let ctx: ExecutionContext;
  let usedEntityPublicId: string;
  let unusedEntityPublicId: string;
  let trackerPublicId: string;
  const logDate = "2026-04-02";

  beforeAll(async () => {
    usedEntityPublicId = await createEntity(`Stats-used-${runSuffix}`, "person");
    unusedEntityPublicId = await createEntity(`Stats-unused-${runSuffix}`, "person");
    trackerPublicId = await createTracker(`Stats ${runSuffix}`, `stats_reps_${runSuffix}`);

    // Two taps of 10, both attributed to the same entity, on one day.
    for (let tap = 0; tap < 2; tap++) {
      await worker.fetch(
        makeRequest(`/trackers/${trackerPublicId}/entries`, "POST", {
          payload: {
            control: "increment",
            date: logDate,
            entityLinks: [{ entityPublicId: usedEntityPublicId, role: "person" }],
          },
        }),
        testEnv,
        createExecutionContext(),
      );
    }
    // Same widened budget as the other remote-D1 suites — five round trips before an assertion.
  }, 120_000);

  afterAll(async () => {
    await worker.fetch(
      makeRequest(`/trackers/${trackerPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
    for (const publicId of [usedEntityPublicId, unusedEntityPublicId]) {
      await worker.fetch(
        makeRequest(`/entities/${publicId}`, "DELETE"),
        testEnv,
        createExecutionContext(),
      );
    }
  }, 120_000);

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  async function getStats(): Promise<StatsRow[]> {
    const res = await worker.fetch(
      makeRequest("/entities?kind=person&withStats=true"),
      testEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats?: StatsRow[] };
    return body.stats ?? [];
  }

  it("counts entries, not readings, and reports the last date an entry landed", async () => {
    const stats = await getStats();
    await waitOnExecutionContext(ctx);

    const row = stats.find((entry) => entry.entityPublicId === usedEntityPublicId);
    expect(row?.entryCount).toBe(2);
    expect(row?.lastEntryDate).toBe(logDate);
  });

  it("totals the metric behind those entries", async () => {
    const stats = await getStats();
    await waitOnExecutionContext(ctx);

    const row = stats.find((entry) => entry.entityPublicId === usedEntityPublicId);
    // Two taps of step 10 against one count metric — a single combinable total.
    expect(row?.total?.sum).toBe(20);
    expect(row?.total?.canonicalUnit).toBe("count");
    expect(row?.total?.defaultAgg).toBe("sum");
  });

  it("gives an untouched entity a zero count and no total — 0 entries is a fact, 0 units is not", async () => {
    const stats = await getStats();
    await waitOnExecutionContext(ctx);

    const row = stats.find((entry) => entry.entityPublicId === unusedEntityPublicId);
    expect(row).toBeDefined();
    expect(row?.entryCount).toBe(0);
    expect(row?.lastEntryDate).toBeNull();
    expect(row?.total).toBeNull();
  });

  it("omits stats entirely when the caller didn't ask for them", async () => {
    const res = await worker.fetch(
      makeRequest("/entities?kind=person"),
      testEnv,
      createExecutionContext(),
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entities: unknown[]; stats?: unknown };
    expect(body.entities.length).toBeGreaterThan(0);
    expect(body.stats).toBeUndefined();
  });
});
