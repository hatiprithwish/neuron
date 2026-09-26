import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import getDbClient from "@/db/dbClient";
import { dailyFacts, entries, entryEntities, entryValues } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

type WriteEntryValueParam = {
  metricId: number;
  valueNum?: number | null;
  valueText?: string | null;
  valueJson?: string | null;
  currency?: string | null;
  valueBase?: number | null;
  fxRate?: number | null;
};

type WriteEntryEntityLinkParam = { entityId: number; role: Schemas.EntryRole };

type WriteEntryParams = {
  userId: string;
  trackerId: number;
  entryKind?: Schemas.EntryKind;
  occurredAt: Date;
  endedAt?: Date | null;
  localDate: string;
  tz: string;
  label?: string | null;
  note?: string | null;
  source?: string;
  transferGroupId?: string | null;
  values: WriteEntryValueParam[];
  entityLinks?: WriteEntryEntityLinkParam[];
};

type EntryWithParts = Schemas.Entry & {
  values: Schemas.EntryValue[];
  entities: Schemas.EntryEntityLink[];
};

export default class EntriesDAL {
  private db: DrizzleD1Database;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  // DEV_NOTE: entries is append-mostly — this always inserts a new row, never upserts against an
  // existing one. Idempotent "log/unlog a day" semantics are domain business logic (e.g. HabitsRepo
  // checking getEntries before deciding to write or delete), not something this generic DAL assumes.
  async writeEntry(params: WriteEntryParams) {
    const response: Schemas.ApiResponse & { entry?: EntryWithParts } = { isSuccess: false };

    try {
      const now = new Date();
      const entryRow = await this.db
        .insert(entries)
        .values({
          publicId: Utility.generatePublicId("eny_"),
          userId: params.userId,
          trackerId: params.trackerId,
          entryKind: params.entryKind ?? "point",
          occurredAt: params.occurredAt,
          endedAt: params.endedAt ?? null,
          localDate: params.localDate,
          tz: params.tz,
          label: params.label ?? null,
          note: params.note ?? null,
          source: params.source ?? "manual",
          transferGroupId: params.transferGroupId ?? null,
          rev: 1,
          createdAt: now,
          updatedAt: null,
        })
        .returning()
        .get();

      // DEV_NOTE: values can be empty — Time's open session (architecture.md §7 Phase 3) writes the
      // entry at start with no reading yet, since duration isn't known until stop. drizzle's
      // .values([]) is a no-op-shaped call we'd rather not make at all.
      const valueRows = params.values.length
        ? await this.db
            .insert(entryValues)
            .values(
              params.values.map((value) => ({
                entryId: entryRow.id,
                metricId: value.metricId,
                valueNum: value.valueNum ?? null,
                valueText: value.valueText ?? null,
                valueJson: value.valueJson ?? null,
                currency: value.currency ?? null,
                valueBase: value.valueBase ?? null,
                fxRate: value.fxRate ?? null,
              })),
            )
            .returning()
        : [];

      const entityLinkRows = params.entityLinks?.length
        ? await this.db
            .insert(entryEntities)
            .values(
              params.entityLinks.map((link) => ({
                entryId: entryRow.id,
                entityId: link.entityId,
                role: link.role,
              })),
            )
            .returning()
        : [];

      await this.recomputeForValues({
        userId: params.userId,
        localDate: params.localDate,
        metricIds: params.values.map((value) => value.metricId),
        entityIds: (params.entityLinks ?? []).map((link) => link.entityId),
      });

      response.isSuccess = true;
      response.message = "Entry written successfully";
      response.entry = { ...entryRow, values: valueRows, entities: entityLinkRows };
    } catch (error) {
      const message = "Unknown error in writing entry";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.WriteEntry,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: only source "manual" rows — a "manual_retro" row's local_date is a day the user picked,
  // not one derived from when it was written, so it is never a candidate for re-keying.
  async getRekeyCandidates(params: { userId: string }) {
    const response: Schemas.ApiResponse & {
      candidates?: Pick<
        Schemas.Entry,
        "id" | "entryKind" | "localDate" | "occurredAt" | "createdAt"
      >[];
    } = { isSuccess: false };

    try {
      response.candidates = await this.db
        .select({
          id: entries.id,
          entryKind: entries.entryKind,
          localDate: entries.localDate,
          occurredAt: entries.occurredAt,
          createdAt: entries.createdAt,
        })
        .from(entries)
        .where(
          and(
            eq(entries.userId, params.userId),
            eq(entries.source, "manual"),
            isNull(entries.deletedAt),
          ),
        );
      response.isSuccess = true;
      response.message = "Re-key candidates fetched successfully";
    } catch (error) {
      const message = "Unknown error in fetching re-key candidates";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.RekeyEntryDays,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: moves entries to the day they belong to, then recomputes daily_facts for both the day
  // they left and the day they joined (invariant 1 — facts are derived, so they are rebuilt from
  // entries rather than patched). Buckets are deduplicated first: a dozen entries moving between the
  // same two days is two recomputes per metric, not twenty-four.
  async rekeyEntries(params: {
    userId: string;
    tz: string;
    moves: { entryId: number; from: string; to: string }[];
  }) {
    const response: Schemas.ApiResponse & { rekeyedCount?: number } = { isSuccess: false };

    try {
      const now = new Date();

      const idsByTargetDate = new Map<string, number[]>();
      for (const move of params.moves) {
        const bucket = idsByTargetDate.get(move.to) ?? [];
        bucket.push(move.entryId);
        idsByTargetDate.set(move.to, bucket);
      }
      for (const [localDate, ids] of idsByTargetDate) {
        for (const chunk of Utility.chunk(ids)) {
          await this.db
            .update(entries)
            .set({ localDate, tz: params.tz, updatedAt: now, rev: sql`${entries.rev} + 1` })
            .where(and(eq(entries.userId, params.userId), inArray(entries.id, chunk)));
        }
      }

      const entryIds = params.moves.map((move) => move.entryId);
      const metricsByEntry = new Map<number, number[]>();
      const entitiesByEntry = new Map<number, number[]>();
      for (const chunk of Utility.chunk(entryIds)) {
        const [valueRows, linkRows] = await Promise.all([
          this.db
            .select({ entryId: entryValues.entryId, metricId: entryValues.metricId })
            .from(entryValues)
            .where(inArray(entryValues.entryId, chunk)),
          this.db
            .select({ entryId: entryEntities.entryId, entityId: entryEntities.entityId })
            .from(entryEntities)
            .where(inArray(entryEntities.entryId, chunk)),
        ]);
        for (const row of valueRows) {
          metricsByEntry.set(row.entryId, [
            ...(metricsByEntry.get(row.entryId) ?? []),
            row.metricId,
          ]);
        }
        for (const row of linkRows) {
          entitiesByEntry.set(row.entryId, [
            ...(entitiesByEntry.get(row.entryId) ?? []),
            row.entityId,
          ]);
        }
      }

      const buckets = new Map<
        string,
        { localDate: string; metricId: number; entityId: number | null }
      >();
      for (const move of params.moves) {
        for (const localDate of [move.from, move.to]) {
          for (const metricId of metricsByEntry.get(move.entryId) ?? []) {
            for (const entityId of [null, ...(entitiesByEntry.get(move.entryId) ?? [])]) {
              buckets.set(`${localDate}|${metricId}|${entityId ?? ""}`, {
                localDate,
                metricId,
                entityId,
              });
            }
          }
        }
      }
      for (const bucket of buckets.values()) {
        await this.recomputeDailyFacts({ userId: params.userId, ...bucket });
      }

      response.isSuccess = true;
      response.message = "Entries re-keyed successfully";
      response.rekeyedCount = params.moves.length;
    } catch (error) {
      const message = "Unknown error in re-keying entries";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.RekeyEntryDays,
        message,
        error,
        metadata: { userId: params.userId, moveCount: params.moves.length },
      });
      response.message = message;
    }

    return response;
  }

  async getEntries(params: {
    userId: string;
    trackerId: number;
    dateFrom: string;
    dateTo: string;
  }) {
    const response: Schemas.ApiResponse & { entries?: Schemas.Entry[] } = { isSuccess: false };

    try {
      const entriesResponse = await this.db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.userId, params.userId),
            eq(entries.trackerId, params.trackerId),
            gte(entries.localDate, params.dateFrom),
            lte(entries.localDate, params.dateTo),
            isNull(entries.deletedAt),
          ),
        );

      response.isSuccess = true;
      response.message = "Entries fetched successfully";
      response.entries = entriesResponse;
    } catch (error) {
      const message = "Unknown error in listing entries";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEntries,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: the Today screen's ruler — every entry logged on one local_date, across every tracker
  // the user owns. Unlike getEntries above, this is deliberately not scoped to a trackerId: it's the
  // one place the DAL answers a cross-tracker question, because splitting it into N per-tracker
  // calls would cost N round trips against a remote D1 binding for what is one indexed date scan.
  async getEntriesForDate(params: { userId: string; localDate: string }) {
    const response: Schemas.ApiResponse & { entries?: Schemas.Entry[] } = { isSuccess: false };

    try {
      const entriesResponse = await this.db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.userId, params.userId),
            eq(entries.localDate, params.localDate),
            isNull(entries.deletedAt),
          ),
        );

      response.isSuccess = true;
      response.message = "Entries fetched successfully";
      response.entries = entriesResponse;
    } catch (error) {
      const message = "Unknown error in listing entries for date";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetTrackerTimeline,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: architecture.md §6 "Habit heatmap"/"Streaks" — one indexed range scan of daily_facts
  // (IDX_daily_facts_lookup covers userId+metricId+localDate) for the entityId IS NULL row, the
  // canonical un-attributed total. Callers build the full day list themselves — a date with no row
  // here just means nothing was logged, not zero (invariant 7).
  async getDailyFacts(params: {
    userId: string;
    metricId: number;
    dateFrom: string;
    dateTo: string;
  }) {
    const response: Schemas.ApiResponse & { dailyFacts?: Schemas.DailyFact[] } = {
      isSuccess: false,
    };

    try {
      const rows = await this.db
        .select()
        .from(dailyFacts)
        .where(
          and(
            eq(dailyFacts.userId, params.userId),
            eq(dailyFacts.metricId, params.metricId),
            isNull(dailyFacts.entityId),
            gte(dailyFacts.localDate, params.dateFrom),
            lte(dailyFacts.localDate, params.dateTo),
          ),
        );

      response.isSuccess = true;
      response.message = "Daily facts fetched successfully";
      response.dailyFacts = rows;
    } catch (error) {
      const message = "Unknown error in listing daily facts";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDailyFacts,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: the many-metric variant of getDailyFacts — the Today screen renders every tracker at
  // once, and one round trip for N metrics beats N round trips against a remote D1 binding. Same
  // entityId IS NULL canonical-total rule as the single-metric version; callers still build their
  // own day list, since a missing row means "nothing logged", not zero (invariant 7).
  async getDailyFactsForMetrics(params: {
    userId: string;
    metricIds: number[];
    dateFrom: string;
    dateTo: string;
  }) {
    const response: Schemas.ApiResponse & { dailyFacts?: Schemas.DailyFact[] } = {
      isSuccess: false,
    };

    if (params.metricIds.length === 0) {
      response.isSuccess = true;
      response.message = "Daily facts fetched successfully";
      response.dailyFacts = [];
      return response;
    }

    try {
      // DEV_NOTE: chunked because this binds one parameter per metric — a user with a hundred
      // trackers would otherwise blow D1's 100-parameter cap and take the whole Today screen down.
      const rows: Schemas.DailyFact[] = [];
      for (const metricIds of Utility.chunk(params.metricIds)) {
        const chunkRows = await this.db
          .select()
          .from(dailyFacts)
          .where(
            and(
              eq(dailyFacts.userId, params.userId),
              inArray(dailyFacts.metricId, metricIds),
              isNull(dailyFacts.entityId),
              gte(dailyFacts.localDate, params.dateFrom),
              lte(dailyFacts.localDate, params.dateTo),
            ),
          );
        rows.push(...chunkRows);
      }

      response.isSuccess = true;
      response.message = "Daily facts fetched successfully";
      response.dailyFacts = rows;
    } catch (error) {
      const message = "Unknown error in listing daily facts for metrics";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDailyFactsForMetrics,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: plain getEntries is enough for Habits — presence of an entry is the whole signal, a
  // toggle has no value worth reading back. Money's expenses need the amount/currency/account/
  // category that live in entry_values/entry_entities, so this variant joins both in. Two extra
  // queries by entryId (not a SQL join) because entry_values/entry_entities have no independent
  // identity to select distinctly from a joined row set without duplicating the entry per value.
  async getEntriesWithParts(params: {
    userId: string;
    trackerId: number;
    dateFrom: string;
    dateTo: string;
  }) {
    const response: Schemas.ApiResponse & { entries?: EntryWithParts[] } = { isSuccess: false };

    try {
      const entryRows = await this.db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.userId, params.userId),
            eq(entries.trackerId, params.trackerId),
            gte(entries.localDate, params.dateFrom),
            lte(entries.localDate, params.dateTo),
            isNull(entries.deletedAt),
          ),
        );

      if (entryRows.length === 0) {
        response.isSuccess = true;
        response.message = "Entries fetched successfully";
        response.entries = [];
        return response;
      }

      // DEV_NOTE: same 100-parameter cap — a month of entries is easily past it, so these two
      // lookups are chunked over the entry ids rather than assuming the range is small.
      const entryIds = entryRows.map((entry) => entry.id);
      const valueRows: (typeof entryValues.$inferSelect)[] = [];
      const entityRows: (typeof entryEntities.$inferSelect)[] = [];
      for (const idChunk of Utility.chunk(entryIds)) {
        const [values, links] = await Promise.all([
          this.db.select().from(entryValues).where(inArray(entryValues.entryId, idChunk)),
          this.db.select().from(entryEntities).where(inArray(entryEntities.entryId, idChunk)),
        ]);
        valueRows.push(...values);
        entityRows.push(...links);
      }

      response.isSuccess = true;
      response.message = "Entries fetched successfully";
      response.entries = entryRows.map((entry) => ({
        ...entry,
        values: valueRows.filter((value) => value.entryId === entry.id),
        entities: entityRows.filter((link) => link.entryId === entry.id),
      }));
    } catch (error) {
      const message = "Unknown error in listing entries with parts";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEntriesWithParts,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: invariant 9 — soft delete only. entry_values/entry_entities rows for this entry are
  // left in place (they have no independent identity to soft-delete) — every read joins through
  // entries.deleted_at is null, so they simply stop being reachable.
  async deleteEntry(params: { userId: string; publicId: string }) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const now = new Date();
      const deleted = await this.db
        .update(entries)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(entries.publicId, params.publicId),
            eq(entries.userId, params.userId),
            isNull(entries.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!deleted) {
        const message = "Entry not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteEntry,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [linkedValues, linkedEntities] = await Promise.all([
        this.db.select().from(entryValues).where(eq(entryValues.entryId, deleted.id)),
        this.db.select().from(entryEntities).where(eq(entryEntities.entryId, deleted.id)),
      ]);

      await this.recomputeForValues({
        userId: deleted.userId,
        localDate: deleted.localDate,
        metricIds: linkedValues.map((value) => value.metricId),
        entityIds: linkedEntities.map((link) => link.entityId),
      });

      response.isSuccess = true;
      response.message = "Entry deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting entry";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteEntry,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: shared by writeEntry, deleteEntry and appendEntryValue — all three end with the same
  // "recompute the canonical bucket, then each linked entity's bucket, for every affected metric"
  // fan-out (rule of three — this used to be copy-pasted in writeEntry and deleteEntry).
  private async recomputeForValues(params: {
    userId: string;
    localDate: string;
    metricIds: number[];
    entityIds: number[];
  }) {
    for (const metricId of params.metricIds) {
      await this.recomputeDailyFacts({
        userId: params.userId,
        localDate: params.localDate,
        metricId,
        entityId: null,
      });
      for (const entityId of params.entityIds) {
        await this.recomputeDailyFacts({
          userId: params.userId,
          localDate: params.localDate,
          metricId,
          entityId,
        });
      }
    }
  }

  // DEV_NOTE: architecture.md §7 Phase 3 — the one approved, narrowly-scoped exception to
  // "append-mostly" (entries.ended_at only). Guarded by ended_at IS NULL in the WHERE clause, so
  // calling this twice on an already-closed session is a no-op "not found", not a double-close. Also
  // guarded by entry_kind = "interval" — a "point" entry (e.g. a Habit tap) also has ended_at null by
  // default, and this must never be reachable from any tracker but the one that owns interval rows.
  async updateEntryEndedAt(params: { userId: string; publicId: string; endedAt: Date }) {
    const response: Schemas.ApiResponse & { entry?: Schemas.Entry } = { isSuccess: false };

    try {
      const now = new Date();
      const updated = await this.db
        .update(entries)
        .set({ endedAt: params.endedAt, updatedAt: now, rev: sql`${entries.rev} + 1` })
        .where(
          and(
            eq(entries.publicId, params.publicId),
            eq(entries.userId, params.userId),
            eq(entries.entryKind, "interval"),
            isNull(entries.deletedAt),
            isNull(entries.endedAt),
          ),
        )
        .returning()
        .get();

      if (!updated) {
        const message = "Open session not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateEntryEndedAt,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Entry closed successfully";
      response.entry = updated;
    } catch (error) {
      const message = "Unknown error in closing entry";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateEntryEndedAt,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: appends a reading to an entry that was written without one (Time's open session) —
  // still a pure insert into entry_values, never an update. Only entries.ended_at is mutable.
  async appendEntryValue(params: {
    userId: string;
    entryId: number;
    localDate: string;
    metricId: number;
    valueNum?: number | null;
    entityIds?: number[];
  }) {
    const response: Schemas.ApiResponse & { value?: Schemas.EntryValue } = { isSuccess: false };

    try {
      const valueRow = await this.db
        .insert(entryValues)
        .values({
          entryId: params.entryId,
          metricId: params.metricId,
          valueNum: params.valueNum ?? null,
        })
        .returning()
        .get();

      await this.recomputeForValues({
        userId: params.userId,
        localDate: params.localDate,
        metricIds: [params.metricId],
        entityIds: params.entityIds ?? [],
      });

      response.isSuccess = true;
      response.message = "Value appended successfully";
      response.value = valueRow;
    } catch (error) {
      const message = "Unknown error in appending entry value";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.AppendEntryValue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: architecture.md §7 Phase 3 — finds a tracker's open interval (running timer). Used by
  // start (enforce one running session at a time) and the running-session indicator. Returns the
  // full EntryWithParts shape so a linked entity can be resolved without a
  // second round trip.
  async getOpenIntervalEntry(params: { userId: string; trackerId: number }) {
    const response: Schemas.ApiResponse & { entry?: EntryWithParts | null } = { isSuccess: false };

    try {
      const [entry] = await this.db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.userId, params.userId),
            eq(entries.trackerId, params.trackerId),
            eq(entries.entryKind, "interval"),
            isNull(entries.endedAt),
            isNull(entries.deletedAt),
          ),
        )
        .limit(1);

      if (!entry) {
        response.isSuccess = true;
        response.message = "No open session";
        response.entry = null;
        return response;
      }

      const [valueRows, entityRows] = await Promise.all([
        this.db.select().from(entryValues).where(eq(entryValues.entryId, entry.id)),
        this.db.select().from(entryEntities).where(eq(entryEntities.entryId, entry.id)),
      ]);

      response.isSuccess = true;
      response.message = "Open session fetched successfully";
      response.entry = { ...entry, values: valueRows, entities: entityRows };
    } catch (error) {
      const message = "Unknown error in fetching open session";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetOpenIntervalEntry,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: architecture.md §6 "Cross-domain aggregation" / docs/archive/implementation.md Phase 4 — the one
  // hand-written cross-domain query, not a query builder. One entity, every metric attributed to it,
  // summed over a date range.
  //
  // Two paths, because daily_facts has no role column:
  //   no role — read the entity-scoped daily_facts rows directly, which is what they exist for. They
  //     are keyed (user, date, metric, entity) and were computed from the DISTINCT entries linked to
  //     that entity, so one entry linked to the same entity under two roles still counts once.
  //   role    — fall back to entries ⋈ entry_values ⋈ entry_entities filtered to that single role.
  //     Same COALESCE(value_base, value_num) as recomputeDailyFacts uses, so both paths total in the
  //     user's home currency and agree with each other (invariant 3).
  //
  // Filtering to ONE entity is what keeps invariant 6 satisfied: there is nothing to group across, so
  // an entry pointing at three entities contributes to each of their rollups once, and is never
  // triple-counted inside one of them.
  async getEntityRollup(params: {
    userId: string;
    entityId: number;
    dateFrom: string;
    dateTo: string;
    role?: Schemas.EntryRole;
  }) {
    // DEV_NOTE: min/max travel alongside sum/count so the Repo can apply each metric's own
    // default_agg over the range (Aggregation.rangeValue) instead of every metric being totalled.
    // Both are composable out of the day grain — MIN of the daily minimums is the range's minimum —
    // which is why the week/month/year views need no second cache (architecture.md §1). `avg` is
    // deliberately absent: averaging the daily averages would weight a day with one reading equally
    // with a day of twenty, so the Repo derives it as sum/count instead.
    const response: Schemas.ApiResponse & {
      rows?: {
        metricId: number;
        sum: number;
        count: number;
        min: number | null;
        max: number | null;
      }[];
    } = { isSuccess: false };

    try {
      const amount = sql`COALESCE(${entryValues.valueBase}, ${entryValues.valueNum})`;

      const rows = params.role
        ? await this.db
            .select({
              metricId: entryValues.metricId,
              sum: sql<number>`COALESCE(SUM(${amount}), 0)`.mapWith(Number),
              count: sql<number>`COUNT(*)`.mapWith(Number),
              min: sql<number | null>`MIN(${amount})`,
              max: sql<number | null>`MAX(${amount})`,
            })
            .from(entryValues)
            .innerJoin(entries, eq(entries.id, entryValues.entryId))
            .innerJoin(
              entryEntities,
              and(
                eq(entryEntities.entryId, entries.id),
                eq(entryEntities.entityId, params.entityId),
                eq(entryEntities.role, params.role),
              ),
            )
            .where(
              and(
                eq(entries.userId, params.userId),
                gte(entries.localDate, params.dateFrom),
                lte(entries.localDate, params.dateTo),
                isNull(entries.deletedAt),
              ),
            )
            .groupBy(entryValues.metricId)
        : await this.db
            .select({
              metricId: dailyFacts.metricId,
              sum: sql<number>`COALESCE(SUM(${dailyFacts.sum}), 0)`.mapWith(Number),
              count: sql<number>`COALESCE(SUM(${dailyFacts.count}), 0)`.mapWith(Number),
              min: sql<number | null>`MIN(${dailyFacts.min})`,
              max: sql<number | null>`MAX(${dailyFacts.max})`,
            })
            .from(dailyFacts)
            .where(
              and(
                eq(dailyFacts.userId, params.userId),
                eq(dailyFacts.entityId, params.entityId),
                gte(dailyFacts.localDate, params.dateFrom),
                lte(dailyFacts.localDate, params.dateTo),
              ),
            )
            .groupBy(dailyFacts.metricId);

      response.isSuccess = true;
      response.message = "Entity rollup fetched successfully";
      response.rows = rows;
    } catch (error) {
      const message = "Unknown error in fetching entity rollup";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEntityRollup,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: backs the Things screen's per-row usage line (design/things-mobile.png). Two grouped
  // queries for every entity a user has, not one per row — the screen shows six kinds at once, and a
  // request per entity is the shape this exists to avoid.
  //
  // DEV_NOTE: the counts come off `entries` and the totals off `daily_facts` on purpose. "47 entries"
  // is a fact about entries, and daily_facts.count counts readings (a four-reading meal is one
  // entry); the money/time total, meanwhile, is exactly what daily_facts materialises, and the
  // no-role branch of getEntityRollup already reads it the same way.
  async getEntityUsage(params: { userId: string }) {
    const response: Schemas.ApiResponse & {
      usage?: { entityId: number; entryCount: number; lastEntryDate: string | null }[];
      totals?: {
        entityId: number;
        metricId: number;
        sum: number;
        count: number;
        min: number | null;
        max: number | null;
      }[];
    } = { isSuccess: false };

    try {
      const [usage, totals] = await Promise.all([
        // DEV_NOTE: COUNT(DISTINCT), not COUNT(*) — entry_entities' PK is (entry_id, role), so one
        // entry that names the same entity under two roles is two rows here
        // and still one entry.
        this.db
          .select({
            entityId: entryEntities.entityId,
            entryCount: sql<number>`COUNT(DISTINCT ${entries.id})`.mapWith(Number),
            lastEntryDate: sql<string | null>`MAX(${entries.localDate})`,
          })
          .from(entryEntities)
          .innerJoin(entries, eq(entries.id, entryEntities.entryId))
          .where(and(eq(entries.userId, params.userId), isNull(entries.deletedAt)))
          .groupBy(entryEntities.entityId),
        this.db
          .select({
            entityId: dailyFacts.entityId,
            metricId: dailyFacts.metricId,
            sum: sql<number>`COALESCE(SUM(${dailyFacts.sum}), 0)`.mapWith(Number),
            count: sql<number>`COALESCE(SUM(${dailyFacts.count}), 0)`.mapWith(Number),
            min: sql<number | null>`MIN(${dailyFacts.min})`,
            max: sql<number | null>`MAX(${dailyFacts.max})`,
          })
          .from(dailyFacts)
          .where(and(eq(dailyFacts.userId, params.userId), isNotNull(dailyFacts.entityId)))
          .groupBy(dailyFacts.entityId, dailyFacts.metricId),
      ]);

      response.isSuccess = true;
      response.message = "Entity usage fetched successfully";
      response.usage = usage;
      // The isNotNull filter above is what makes this cast safe — the un-attributed bucket
      // (entityId IS NULL) is every entry that named no entity at all, which is nobody's row here.
      response.totals = totals.filter(
        (row): row is (typeof totals)[number] & { entityId: number } => row.entityId !== null,
      );
    } catch (error) {
      const message = "Unknown error in fetching entity usage";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEntityStats,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: architecture.md §6 "Time-tracker breakdown" — queries entries directly (not
  // daily_facts), grouped by label. With a role (the "slice by" parameter) it also left-joins
  // entry_entities for exactly that one role — invariant 6 — so an entry with no entity in it still
  // gets a row (entityId: null) instead of vanishing. Without one it never touches entry_entities.
  // The inner join on entry_values naturally excludes still-running sessions — they have no duration
  // reading yet (invariant 7: nothing to report isn't the same as zero).
  async getIntervalBreakdown(params: {
    userId: string;
    trackerId: number;
    metricId: number;
    dateFrom: string;
    dateTo: string;
    role?: Schemas.EntryRole;
  }) {
    const response: Schemas.ApiResponse & {
      rows?: { label: string | null; entityId: number | null; entryCount: number; total: number }[];
    } = { isSuccess: false };

    try {
      const valuesJoin = and(
        eq(entryValues.entryId, entries.id),
        eq(entryValues.metricId, params.metricId),
      );
      const where = and(
        eq(entries.userId, params.userId),
        eq(entries.trackerId, params.trackerId),
        gte(entries.localDate, params.dateFrom),
        lte(entries.localDate, params.dateTo),
        isNull(entries.deletedAt),
      );
      const entryCount = sql<number>`COUNT(*)`.mapWith(Number);
      const total = sql<number>`COALESCE(SUM(${entryValues.valueNum}), 0)`.mapWith(Number);

      const rows = params.role
        ? await this.db
            .select({ label: entries.label, entityId: entryEntities.entityId, entryCount, total })
            .from(entries)
            .innerJoin(entryValues, valuesJoin)
            .leftJoin(
              entryEntities,
              and(eq(entryEntities.entryId, entries.id), eq(entryEntities.role, params.role)),
            )
            .where(where)
            .groupBy(entries.label, entryEntities.entityId)
        : (
            await this.db
              .select({ label: entries.label, entryCount, total })
              .from(entries)
              .innerJoin(entryValues, valuesJoin)
              .where(where)
              .groupBy(entries.label)
          ).map((row) => ({ ...row, entityId: null }));

      response.isSuccess = true;
      response.message = "Breakdown fetched successfully";
      response.rows = rows;
    } catch (error) {
      const message = "Unknown error in fetching interval breakdown";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetIntervalBreakdown,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: recomputes daily_facts from scratch by aggregating over entries + entry_values —
  // deliberately not a single atomic db.batch with the writes above it, because D1's batch API
  // executes a fixed set of pre-built statements with no read-after-write step in between, and these
  // aggregate values can only be computed after the write/delete above has happened. entries is
  // still the source of truth (invariant 1): if this step never ran, daily_facts would be stale, not
  // wrong, and the next writeEntry/deleteEntry on the same bucket self-heals it.
  //
  // DEV_NOTE: SQLite never treats two NULLs as equal for a uniqueness check, so entityId===null
  // (the canonical, un-attributed total) is handled by isNull rather than eq below — same reasoning
  // applies to the daily_facts upsert target.
  private async recomputeDailyFacts(bucket: {
    userId: string;
    localDate: string;
    metricId: number;
    entityId: number | null;
  }) {
    let matchingEntryIds: number[] | null = null;
    if (bucket.entityId !== null) {
      const links = await this.db
        .select({ entryId: entryEntities.entryId })
        .from(entryEntities)
        .where(eq(entryEntities.entityId, bucket.entityId));
      matchingEntryIds = links.map((link) => link.entryId);
      if (matchingEntryIds.length === 0) {
        await this.deleteDailyFactRow(bucket);
        return;
      }
    }

    const conditions = [
      eq(entries.userId, bucket.userId),
      eq(entries.localDate, bucket.localDate),
      eq(entryValues.metricId, bucket.metricId),
      isNull(entries.deletedAt),
    ];
    if (matchingEntryIds) {
      conditions.push(inArray(entries.id, matchingEntryIds));
    }

    // DEV_NOTE: aggregates on COALESCE(value_base, value_num) — invariant 3. Money's entries carry
    // both: value_num is the amount in the entry's own currency, value_base is that amount converted
    // to the user's home currency, and daily_facts must total in home currency to be meaningful
    // across mixed-currency entries. Every non-money metric (e.g. Habits' boolean values) never sets
    // value_base, so this falls back to value_num exactly as before.
    const amount = sql`COALESCE(${entryValues.valueBase}, ${entryValues.valueNum})`;
    const [aggregate] = await this.db
      .select({
        count: sql<number>`COUNT(*)`.mapWith(Number),
        sum: sql<number>`COALESCE(SUM(${amount}), 0)`.mapWith(Number),
        min: sql<number | null>`MIN(${amount})`,
        max: sql<number | null>`MAX(${amount})`,
        avg: sql<number | null>`AVG(${amount})`,
      })
      .from(entryValues)
      .innerJoin(entries, eq(entries.id, entryValues.entryId))
      .where(and(...conditions));

    if (!aggregate || aggregate.count === 0) {
      await this.deleteDailyFactRow(bucket);
      return;
    }

    const bucketConditions = [
      eq(dailyFacts.userId, bucket.userId),
      eq(dailyFacts.localDate, bucket.localDate),
      eq(dailyFacts.metricId, bucket.metricId),
      bucket.entityId === null
        ? isNull(dailyFacts.entityId)
        : eq(dailyFacts.entityId, bucket.entityId),
    ];

    const now = new Date();
    const existing = await this.db
      .select({ userId: dailyFacts.userId })
      .from(dailyFacts)
      .where(and(...bucketConditions))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(dailyFacts)
        .set({
          sum: aggregate.sum,
          count: aggregate.count,
          min: aggregate.min,
          max: aggregate.max,
          avg: aggregate.avg,
          updatedAt: now,
        })
        .where(and(...bucketConditions));
    } else {
      await this.db.insert(dailyFacts).values({
        userId: bucket.userId,
        localDate: bucket.localDate,
        metricId: bucket.metricId,
        entityId: bucket.entityId,
        sum: aggregate.sum,
        count: aggregate.count,
        min: aggregate.min,
        max: aggregate.max,
        avg: aggregate.avg,
        targetAtTime: null,
        updatedAt: now,
      });
    }
  }

  private async deleteDailyFactRow(bucket: {
    userId: string;
    localDate: string;
    metricId: number;
    entityId: number | null;
  }) {
    await this.db
      .delete(dailyFacts)
      .where(
        and(
          eq(dailyFacts.userId, bucket.userId),
          eq(dailyFacts.localDate, bucket.localDate),
          eq(dailyFacts.metricId, bucket.metricId),
          bucket.entityId === null
            ? isNull(dailyFacts.entityId)
            : eq(dailyFacts.entityId, bucket.entityId),
        ),
      );
  }
}
