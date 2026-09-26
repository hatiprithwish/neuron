import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import EntitiesDAL from "@/data-access-layer/EntitiesDAL";
import MetricsDAL from "@/data-access-layer/MetricsDAL";
import TrackersDAL from "@/data-access-layer/TrackersDAL";
import EntriesDAL from "@/data-access-layer/EntriesDAL";
import getDbClient from "@/db/dbClient";
import { dailyFacts } from "@/db/tables";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

const userId = "user_test_entries";
const dayA = "2026-01-01";
const dayB = "2026-01-02";

async function getDailyFact(metricId: number, entityId: number | null, localDate: string) {
  const db = getDbClient(env);
  const [row] = await db
    .select()
    .from(dailyFacts)
    .where(
      and(
        eq(dailyFacts.userId, userId),
        eq(dailyFacts.localDate, localDate),
        eq(dailyFacts.metricId, metricId),
        entityId === null ? isNull(dailyFacts.entityId) : eq(dailyFacts.entityId, entityId),
      ),
    );
  return row;
}

// DEV_NOTE: D1 here is `remote: true` (see vitest.config.mts) — a real, persistent database, not
// reset between runs. metrics is unique on (user_id, key), so a fixed key made this suite pass
// exactly once ever and fail on every later run against the same database. A run-unique suffix
// scopes each run's fixtures to itself, the same way time.test.ts scopes its session labels.
const runSuffix = Math.random().toString(36).slice(2, 8);

describe("Neuron: entries + entry_values -> daily_facts", () => {
  const entitiesDAL = new EntitiesDAL(env);
  const metricsDAL = new MetricsDAL(env);
  const trackersDAL = new TrackersDAL(env);
  const entriesDAL = new EntriesDAL(env);

  let metricId: number;
  let trackerId: number;
  let trackerPublicId: string;
  let entityId: number;
  let entityPublicId: string;
  const entryPublicIds: string[] = [];

  beforeAll(async () => {
    const metric = await metricsDAL.createMetric({
      userId,
      key: `neuron_test_metric_${runSuffix}`,
      name: `Neuron Test Metric ${runSuffix}`,
      semanticType: "count",
      canonicalUnit: "count",
      defaultAgg: "sum",
      defaultDirection: "higher_better",
      dateAttribution: "start",
    });
    if (!metric.isSuccess || !metric.metric) {
      throw new Error("Failed to create test metric");
    }
    metricId = metric.metric.id;

    const tracker = await trackersDAL.createTracker({
      userId,
      primaryMetricId: metricId,
      name: `Neuron Test Tracker ${runSuffix}`,
      manifest: {
        control: "increment",
        metrics: [metric.metric.key],
        target: null,
        step: 1,
        direction: null,
        entryMode: "live",
        schedule: { type: "daily" },
        compute: null,
      },
      activeFrom: dayA,
    });
    if (!tracker.isSuccess || !tracker.tracker) {
      throw new Error("Failed to create test tracker");
    }
    trackerId = tracker.tracker.id;
    trackerPublicId = tracker.tracker.publicId;

    const entity = await entitiesDAL.createEntity({
      userId,
      kind: "person",
      name: `Neuron Test Project ${runSuffix}`,
    });
    if (!entity.isSuccess || !entity.entity) {
      throw new Error("Failed to create test entity");
    }
    entityId = entity.entity.id;
    entityPublicId = entity.entity.publicId;
  });

  afterAll(async () => {
    // Entries this run's own tests didn't already delete
    for (const publicId of entryPublicIds) {
      await entriesDAL.deleteEntry({ userId, publicId });
    }
    await trackersDAL.deleteTracker({ userId, publicId: trackerPublicId });
    await entitiesDAL.deleteEntity({ userId, publicId: entityPublicId });
  });

  it("rolls up two entries written on the same day into one canonical and one entity-scoped daily_facts row", async () => {
    const first = await entriesDAL.writeEntry({
      userId,
      trackerId,
      occurredAt: new Date(`${dayA}T09:00:00Z`),
      localDate: dayA,
      tz: "UTC",
      source: "manual",
      values: [{ metricId, valueNum: 1 }],
      entityLinks: [{ entityId, role: "person" }],
    });
    const second = await entriesDAL.writeEntry({
      userId,
      trackerId,
      occurredAt: new Date(`${dayA}T18:00:00Z`),
      localDate: dayA,
      tz: "UTC",
      source: "manual",
      values: [{ metricId, valueNum: 1 }],
      entityLinks: [{ entityId, role: "person" }],
    });

    expect(first.isSuccess && first.entry).toBeTruthy();
    expect(second.isSuccess && second.entry).toBeTruthy();
    if (first.entry) entryPublicIds.push(first.entry.publicId);
    if (second.entry) entryPublicIds.push(second.entry.publicId);

    const canonical = await getDailyFact(metricId, null, dayA);
    expect(canonical).toBeDefined();
    expect(canonical?.count).toBe(2);
    expect(canonical?.sum).toBe(2);

    const scoped = await getDailyFact(metricId, entityId, dayA);
    expect(scoped).toBeDefined();
    expect(scoped?.count).toBe(2);
    expect(scoped?.sum).toBe(2);
  });

  it("rolls up a single entry on a different day into its own daily_facts row", async () => {
    const third = await entriesDAL.writeEntry({
      userId,
      trackerId,
      occurredAt: new Date(`${dayB}T09:00:00Z`),
      localDate: dayB,
      tz: "UTC",
      source: "manual",
      values: [{ metricId, valueNum: 1 }],
      entityLinks: [{ entityId, role: "person" }],
    });
    expect(third.isSuccess && third.entry).toBeTruthy();
    if (third.entry) entryPublicIds.push(third.entry.publicId);

    const factA = await getDailyFact(metricId, null, dayA);
    const factB = await getDailyFact(metricId, null, dayB);
    expect(factA?.count).toBe(2); // untouched by day B's write
    expect(factB?.count).toBe(1);
    expect(factB?.sum).toBe(1);
  });

  it("recomputes the daily_facts row when one of two entries is deleted", async () => {
    const toDelete = entryPublicIds.shift();
    if (!toDelete) throw new Error("expected an entry to delete");

    const deleteResult = await entriesDAL.deleteEntry({ userId, publicId: toDelete });
    expect(deleteResult.isSuccess).toBe(true);

    const canonical = await getDailyFact(metricId, null, dayA);
    expect(canonical?.count).toBe(1);
    expect(canonical?.sum).toBe(1);

    const scoped = await getDailyFact(metricId, entityId, dayA);
    expect(scoped?.count).toBe(1);
    expect(scoped?.sum).toBe(1);
  });

  it("deletes the daily_facts row entirely once its last entry for that day is gone", async () => {
    const toDelete = entryPublicIds.shift();
    if (!toDelete) throw new Error("expected an entry to delete");

    const deleteResult = await entriesDAL.deleteEntry({ userId, publicId: toDelete });
    expect(deleteResult.isSuccess).toBe(true);

    const canonical = await getDailyFact(metricId, null, dayA);
    expect(canonical).toBeUndefined();

    const scoped = await getDailyFact(metricId, entityId, dayA);
    expect(scoped).toBeUndefined();
  });
});
