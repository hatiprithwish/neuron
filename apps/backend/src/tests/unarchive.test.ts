import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import worker from "../index";
// DEV_NOTE: no direct db access here, unlike the other suites — every assertion goes through the
// rollup endpoint, because what's under test is the aggregation contract, not the row layout.
// Declare env type for this test suite
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

// Mock Clerk authentication — real token verification needs network + valid keys
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: mockAuthenticateRequest,
    }),
  },
}));

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: wrangler.jsonc's top-level vars sets APP_ENV=local for this test env too, which would
// bypass the Clerk mock below entirely (see AuthMiddleware.ts). Force it off so these tests keep
// exercising the real checkAuth → Clerk path they're actually testing.
const testEnv = { ...env, APP_ENV: "staging" as const };

function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const today = new Date().toISOString().slice(0, 10);

// DEV_NOTE: archiving is the only "delete" this app has (invariant 9), so restore is what stops it
// being a one-way door. The assertions that matter: an archived row leaves the live list and appears
// in the archived one, restoring puts it back, and a restored tracker gets active_to cleared as well
// as archived_at — a tracker that lists fine but renders a dead heatmap is the bug this guards.
const runSuffix = Math.random().toString(36).slice(2, 8);

const toggleManifest = {
  control: "toggle" as const,
  metrics: [] as string[],
  target: null,
  step: null,
  direction: null,
  entryMode: "retro" as const,
  schedule: { type: "daily" as const },
  compute: null,
};

function booleanMetric(name: string) {
  return {
    mode: "new" as const,
    metric: {
      name,
      semanticType: "boolean" as const,
      canonicalUnit: "boolean",
      defaultAgg: "sum" as const,
      defaultDirection: "higher_better" as const,
      dateAttribution: "start" as const,
    },
  };
}

async function createTracker(name: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/trackers", "POST", {
      tracker: { name, manifest: toggleManifest, activeFrom: today },
      metric: booleanMetric(name),
    }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { tracker: { publicId: string } };
  return body.tracker.publicId;
}

async function createEntity(name: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/entities", "POST", { entity: { name, kind: "person" } }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { entity: { publicId: string } };
  return body.entity.publicId;
}

function archive(path: string) {
  return worker.fetch(makeRequest(path, "DELETE"), testEnv, createExecutionContext());
}

function unarchive(path: string) {
  return worker.fetch(makeRequest(path, "POST"), testEnv, createExecutionContext());
}

async function listPublicIds(path: string, key: "trackers" | "entities"): Promise<string[]> {
  const res = await worker.fetch(makeRequest(path), testEnv, createExecutionContext());
  const body = (await res.json()) as Record<string, { publicId: string }[]>;
  return (body[key] ?? []).map((row) => row.publicId);
}

describe("Restoring an archived tracker", () => {
  let ctx: ExecutionContext;
  let trackerPublicId: string;

  beforeAll(async () => {
    trackerPublicId = await createTracker(`Restore Me ${runSuffix}`);
  }, 120_000);

  afterAll(async () => {
    await archive(`/trackers/${trackerPublicId}`);
  }, 120_000);

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  it("moves between the live list and the archived list, and comes back", async () => {
    expect(await listPublicIds("/trackers", "trackers")).toContain(trackerPublicId);

    const archived = await archive(`/trackers/${trackerPublicId}`);
    expect(archived.status).toBe(200);

    expect(await listPublicIds("/trackers", "trackers")).not.toContain(trackerPublicId);
    expect(await listPublicIds("/trackers?archived=true", "trackers")).toContain(trackerPublicId);

    const restored = await unarchive(`/trackers/${trackerPublicId}/unarchive`);
    await waitOnExecutionContext(ctx);
    expect(restored.status).toBe(200);

    const body = (await restored.json()) as {
      tracker: { publicId: string; archivedAt: string | null; activeTo: string | null };
    };
    expect(body.tracker.publicId).toBe(trackerPublicId);
    expect(body.tracker.archivedAt).toBeNull();
    // DEV_NOTE: archiveTracker sets active_to as well as archived_at — restoring has to clear both,
    // or the tracker returns to the list with its history frozen at the archive date.
    expect(body.tracker.activeTo).toBeNull();

    expect(await listPublicIds("/trackers", "trackers")).toContain(trackerPublicId);
    expect(await listPublicIds("/trackers?archived=true", "trackers")).not.toContain(
      trackerPublicId,
    );
  });

  it("restoring a tracker that was never archived is a 404, not a silent rewrite", async () => {
    const res = await unarchive(`/trackers/${trackerPublicId}/unarchive`);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});

describe("Restoring an archived entity", () => {
  let ctx: ExecutionContext;
  let entityPublicId: string;

  beforeAll(async () => {
    entityPublicId = await createEntity(`Restore Project ${runSuffix}`);
  }, 120_000);

  afterAll(async () => {
    await archive(`/entities/${entityPublicId}`);
  }, 120_000);

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  it("comes back into its kind's list after restore", async () => {
    await archive(`/entities/${entityPublicId}`);
    expect(await listPublicIds("/entities?kind=person", "entities")).not.toContain(entityPublicId);

    // DEV_NOTE: the archived list is deliberately kind-less — the restore screen shows everything
    // archived, whatever kind it was.
    expect(await listPublicIds("/entities?archived=true", "entities")).toContain(entityPublicId);

    const restored = await unarchive(`/entities/${entityPublicId}/unarchive`);
    await waitOnExecutionContext(ctx);
    expect(restored.status).toBe(200);

    const body = (await restored.json()) as { entity: { archivedAt: string | null } };
    expect(body.entity.archivedAt).toBeNull();
    expect(await listPublicIds("/entities?kind=person", "entities")).toContain(entityPublicId);
  });
});

// DEV_NOTE: this describe signs in as its OWN user. "Restore everything" is by definition unscoped
// — run against the shared user_test123 it would un-archive every fixture every other suite (and
// every past run) ever archived in this persistent remote DB, silently changing their starting
// state. A run-unique user makes the count exact instead of "at least", and keeps the blast radius
// inside this file.
describe("Restore everything", () => {
  let ctx: ExecutionContext;
  let firstPublicId: string;
  let secondPublicId: string;
  const bulkUserId = `user_bulk_${runSuffix}`;

  function signInAsBulkUser() {
    mockAuthenticateRequest.mockResolvedValue({
      isSignedIn: true,
      reason: null,
      toAuth: () => ({
        userId: bulkUserId,
        sessionClaims: { email: "bulk@example.com" },
      }),
    });
  }

  beforeAll(async () => {
    signInAsBulkUser();
    firstPublicId = await createTracker(`Bulk One ${runSuffix}`);
    secondPublicId = await createTracker(`Bulk Two ${runSuffix}`);
    await archive(`/trackers/${firstPublicId}`);
    await archive(`/trackers/${secondPublicId}`);
  }, 120_000);

  afterAll(async () => {
    signInAsBulkUser();
    await archive(`/trackers/${firstPublicId}`);
    await archive(`/trackers/${secondPublicId}`);
  }, 120_000);

  beforeEach(() => {
    ctx = createExecutionContext();
    signInAsBulkUser();
  });

  it("restores every archived tracker in one call and reports how many", async () => {
    const res = await unarchive("/trackers/unarchive-all");
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { restoredCount: number };
    expect(body.restoredCount).toBe(2);

    const live = await listPublicIds("/trackers", "trackers");
    expect(live).toContain(firstPublicId);
    expect(live).toContain(secondPublicId);
    expect(await listPublicIds("/trackers?archived=true", "trackers")).toHaveLength(0);
  });
});

describe("Unauthenticated requests", () => {
  it("POST /trackers/unarchive-all without auth returns 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      isSignedIn: false,
      reason: "no-token",
      toAuth: () => null,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(makeRequest("/trackers/unarchive-all", "POST"), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
