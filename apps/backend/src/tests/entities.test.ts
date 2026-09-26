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

const runSuffix = Math.random().toString(36).slice(2, 8);

// DEV_NOTE: entity CRUD used to be tested only incidentally, through Money's account/category
// fixtures. Editing is its own surface now, and its one real rule — kind is immutable — is worth an
// explicit test, because the failure it prevents (an account silently becoming a person while past
// entries stay linked under role "account") is invisible until a rollup disagrees with a list.

async function createEntity(name: string, kind: string): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/entities", "POST", { entity: { name, kind } }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { entity: { publicId: string } };
  return body.entity.publicId;
}

function patch(publicId: string, entity: unknown) {
  return worker.fetch(
    makeRequest(`/entities/${publicId}`, "PATCH", { entity }),
    testEnv,
    createExecutionContext(),
  );
}

function get(publicId: string) {
  return worker.fetch(makeRequest(`/entities/${publicId}`), testEnv, createExecutionContext());
}

describe("Editing an entity", () => {
  let ctx: ExecutionContext;
  let entityPublicId: string;

  beforeAll(async () => {
    entityPublicId = await createEntity(`Editable ${runSuffix}`, "account");
  }, 120_000);

  afterAll(async () => {
    await worker.fetch(
      makeRequest(`/entities/${entityPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
  }, 120_000);

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  it("renames without touching the fields it wasn't given", async () => {
    const withColor = await patch(entityPublicId, { colorIndex: 3 });
    expect(withColor.status).toBe(200);

    const renamed = await patch(entityPublicId, { name: `Renamed ${runSuffix}` });
    await waitOnExecutionContext(ctx);
    expect(renamed.status).toBe(200);

    const body = (await renamed.json()) as { entity: { name: string; colorIndex: number | null } };
    expect(body.entity.name).toBe(`Renamed ${runSuffix}`);
    // The rename didn't send colorIndex — a partial update must not blank what it never saw.
    expect(body.entity.colorIndex).toBe(3);
  });

  it("keeps the change after a reload, and never leaks the internal id", async () => {
    const res = await get(entityPublicId);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      entity: { name: string; publicId: string; id?: unknown; parentId?: unknown };
    };
    expect(body.entity.name).toBe(`Renamed ${runSuffix}`);
    expect(body.entity.publicId).toBe(entityPublicId);
    expect(body.entity.id).toBeUndefined();
    expect(body.entity.parentId).toBeUndefined();
  });

  it("rejects a kind change — the schema doesn't accept the field at all", async () => {
    const res = await patch(entityPublicId, { kind: "person" });
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);

    const after = await get(entityPublicId);
    const body = (await after.json()) as { entity: { kind: string } };
    expect(body.entity.kind).toBe("account");
  });

  it("rejects an empty patch rather than bumping updated_at for nothing", async () => {
    const res = await patch(entityPublicId, {});
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("refuses to make an entity its own parent", async () => {
    const res = await patch(entityPublicId, { parentPublicId: entityPublicId });
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  // DEV_NOTE: archiving is a visibility flag, not a lock — fixing a typo in something you archived
  // shouldn't require restoring it first.
  it("an archived entity is still editable", async () => {
    const archivedEntity = await createEntity(`Archived Editable ${runSuffix}`, "person");
    await worker.fetch(
      makeRequest(`/entities/${archivedEntity}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );

    const res = await patch(archivedEntity, { name: `Fixed Typo ${runSuffix}` });
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: { name: string; archivedAt: string | null } };
    expect(body.entity.name).toBe(`Fixed Typo ${runSuffix}`);
    expect(body.entity.archivedAt).not.toBeNull();
  });
});

describe("Unauthenticated requests", () => {
  it("PATCH /entities/:publicId without auth returns 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      isSignedIn: false,
      reason: "no-token",
      toAuth: () => null,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeRequest("/entities/ent_none", "PATCH", { entity: { name: "nope" } }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
