import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import worker from "../index";
import getDbClient from "@/db/dbClient";
import { dailyFacts, entities, entries, metrics } from "@/db/tables";

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
const TEST_USER_ID = "user_test123";

function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const today = new Date().toISOString().slice(0, 10);

// DEV_NOTE: Money after the manifest engine — it is no longer a Repo, it is one tracker row.
// Expenses are the amount_pad control (amount + currency + fxRate + role-scoped entity links);
// transfers are the one thing no control could express, so they go through the compute escape
// hatch (architecture.md §5, ComputeRegistry's money.transfer.v1). Accounts and categories are
// ordinary entities of kind "account" / "person" on the generic /entities surface.
const MONEY_MANIFEST = {
  control: "amount_pad" as const,
  metrics: ["money_expense_amount", "money_transfer_amount"],
  target: null,
  step: null,
  direction: null,
  entryMode: "retro" as const,
  schedule: { type: "daily" as const },
  compute: "money.transfer.v1" as const,
};

const currencyMetric = (
  key: string,
  name: string,
  defaultDirection: "lower_better" | "neutral",
) => ({
  key,
  name,
  semanticType: "currency_minor" as const,
  canonicalUnit: "currency_minor",
  defaultAgg: "sum" as const,
  defaultDirection,
  dateAttribution: "start" as const,
});

async function createEntity(name: string, kind: "account" | "person"): Promise<string> {
  const res = await worker.fetch(
    makeRequest("/entities", "POST", { entity: { name, kind } }),
    testEnv,
    createExecutionContext(),
  );
  const body = (await res.json()) as { entity: { publicId: string } };
  return body.entity.publicId;
}

describe("Money as a manifest tracker (authenticated)", () => {
  let ctx: ExecutionContext;
  let moneyTrackerPublicId: string;
  let cashAccountPublicId: string;
  let bankAccountPublicId: string;
  let friendPersonPublicId: string;

  beforeAll(async () => {
    // DEV_NOTE: money_transfer_amount has to exist before the tracker names it in manifest.metrics
    // — validateComputeManifest rejects a compute module whose required metrics aren't declared,
    // and the Repo resolves declared keys to ids at write time.
    await worker.fetch(
      makeRequest("/metrics", "POST", {
        metric: currencyMetric("money_transfer_amount", "Transfer amount", "neutral"),
      }),
      testEnv,
      createExecutionContext(),
    );

    const trackerRes = await worker.fetch(
      makeRequest("/trackers", "POST", {
        tracker: { name: "Money", manifest: MONEY_MANIFEST, activeFrom: today },
        metric: {
          mode: "new",
          metric: currencyMetric("money_expense_amount", "Expense amount", "lower_better"),
        },
      }),
      testEnv,
      createExecutionContext(),
    );
    const tracker = (await trackerRes.json()) as { tracker: { publicId: string } };
    moneyTrackerPublicId = tracker.tracker.publicId;

    cashAccountPublicId = await createEntity("Cash", "account");
    bankAccountPublicId = await createEntity("Bank", "account");
    friendPersonPublicId = await createEntity("Sam", "person");
    // DEV_NOTE: same reasoning as time.test.ts's breakdown hook — five remote round trips before a
    // single assertion runs, comfortably inside 30s on a good day and not on a bad one.
  }, 120_000);

  afterAll(async () => {
    for (const publicId of [cashAccountPublicId, bankAccountPublicId, friendPersonPublicId]) {
      await worker.fetch(
        makeRequest(`/entities/${publicId}`, "DELETE"),
        testEnv,
        createExecutionContext(),
      );
    }
    await worker.fetch(
      makeRequest(`/trackers/${moneyTrackerPublicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
  });

  beforeEach(() => {
    ctx = createExecutionContext();
  });

  it("creates accounts and people, structurally publicId-only", async () => {
    expect(cashAccountPublicId).toEqual(expect.any(String));
    expect(friendPersonPublicId).toEqual(expect.any(String));

    const listRes = await worker.fetch(makeRequest("/entities?kind=account"), testEnv, ctx);
    const list = (await listRes.json()) as { entities: { publicId: string; id?: unknown }[] };
    const cash = list.entities.find((entity) => entity.publicId === cashAccountPublicId);
    expect(cash).toBeDefined();
    expect(cash?.id).toBeUndefined();
  });

  it("logging an expense in a foreign currency stores value_base in home currency and fx_rate", async () => {
    const res = await worker.fetch(
      makeRequest(`/trackers/${moneyTrackerPublicId}/entries`, "POST", {
        payload: {
          control: "amount_pad",
          date: "2026-02-01",
          amountMinor: 5000, // $50.00
          currency: "USD",
          fxRate: 83, // 1 USD = 83 (minor-unit-consistent) home currency units
          entityLinks: [
            { entityPublicId: cashAccountPublicId, role: "account" },
            { entityPublicId: friendPersonPublicId, role: "person" },
          ],
        },
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      isSuccess: boolean;
      entry: {
        values: {
          valueNum: number;
          currency: string | null;
          valueBase: number | null;
          fxRate: number | null;
        }[];
        entities: { entityPublicId: string; role: string }[];
      };
    };
    expect(body.isSuccess).toBe(true);

    const value = body.entry.values[0];
    expect(value.currency).toBe("USD");
    expect(value.fxRate).toBe(83);
    expect(value.valueBase).toBe(5000 * 83);

    const roles = Object.fromEntries(
      body.entry.entities.map((link) => [link.role, link.entityPublicId]),
    );
    expect(roles.account).toBe(cashAccountPublicId);
    expect(roles.person).toBe(friendPersonPublicId);
  });

  it("an expense against an archived account is rejected", async () => {
    const doomedAccount = await createEntity("Closed Card", "account");
    await worker.fetch(
      makeRequest(`/entities/${doomedAccount}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );

    const res = await worker.fetch(
      makeRequest(`/trackers/${moneyTrackerPublicId}/entries`, "POST", {
        payload: {
          control: "amount_pad",
          date: "2026-02-01",
          amountMinor: 100,
          currency: "INR",
          fxRate: 1,
          entityLinks: [{ entityPublicId: doomedAccount, role: "account" }],
        },
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("a transfer shares one transfer_group_id and moves each account's daily total in the correct direction", async () => {
    const res = await worker.fetch(
      makeRequest(`/trackers/${moneyTrackerPublicId}/compute`, "POST", {
        compute: {
          key: "money.transfer.v1",
          payload: {
            fromAccountPublicId: cashAccountPublicId,
            toAccountPublicId: bankAccountPublicId,
            amountMinor: 2000,
            currency: "INR",
            date: "2026-02-02",
          },
        },
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { transfer: { transferGroupId: string } };
    const transferGroupId = body.transfer.transferGroupId;
    expect(transferGroupId).toEqual(expect.any(String));

    const db = getDbClient(testEnv);
    const sides = await db
      .select()
      .from(entries)
      .where(and(eq(entries.transferGroupId, transferGroupId), isNull(entries.deletedAt)));
    expect(sides).toHaveLength(2);

    const [transferMetric] = await db
      .select()
      .from(metrics)
      .where(and(eq(metrics.userId, TEST_USER_ID), eq(metrics.key, "money_transfer_amount")));
    const [cashEntity] = await db
      .select()
      .from(entities)
      .where(eq(entities.publicId, cashAccountPublicId));
    const [bankEntity] = await db
      .select()
      .from(entities)
      .where(eq(entities.publicId, bankAccountPublicId));

    const factFor = async (entityId: number) => {
      const [fact] = await db
        .select()
        .from(dailyFacts)
        .where(
          and(
            eq(dailyFacts.userId, TEST_USER_ID),
            eq(dailyFacts.localDate, "2026-02-02"),
            eq(dailyFacts.metricId, transferMetric.id),
            eq(dailyFacts.entityId, entityId),
          ),
        );
      return fact;
    };

    expect((await factFor(cashEntity.id)).sum).toBe(-2000);
    expect((await factFor(bankEntity.id)).sum).toBe(2000);
  });

  it("rejects a compute key the tracker's manifest doesn't declare", async () => {
    const plainTrackerRes = await worker.fetch(
      makeRequest("/trackers", "POST", {
        tracker: {
          name: "No Compute Tracker",
          manifest: { ...MONEY_MANIFEST, compute: null },
          activeFrom: today,
        },
        metric: {
          mode: "new",
          metric: currencyMetric("money_expense_amount", "Expense amount", "lower_better"),
        },
      }),
      testEnv,
      createExecutionContext(),
    );
    const plainTracker = (await plainTrackerRes.json()) as { tracker: { publicId: string } };

    const res = await worker.fetch(
      makeRequest(`/trackers/${plainTracker.tracker.publicId}/compute`, "POST", {
        compute: {
          key: "money.transfer.v1",
          payload: {
            fromAccountPublicId: cashAccountPublicId,
            toAccountPublicId: bankAccountPublicId,
            amountMinor: 100,
            currency: "INR",
            date: "2026-02-03",
          },
        },
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);

    await worker.fetch(
      makeRequest(`/trackers/${plainTracker.tracker.publicId}`, "DELETE"),
      testEnv,
      createExecutionContext(),
    );
  });
});

describe("Unauthenticated requests", () => {
  it("GET /entities without auth returns 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      isSignedIn: false,
      reason: "no-token",
      toAuth: () => null,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(makeRequest("/entities?kind=account"), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
