import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import getDbClient from "@/db/dbClient";
import { trackers, trackerTargets } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

type CreateTrackerParams = {
  userId: string;
  primaryMetricId: number;
  name: string;
  icon?: string | null;
  colorIndex?: number | null;
  manifest: Schemas.TrackerManifest;
  sortOrder?: number;
  activeFrom: string;
  activeTo?: string | null;
  reminderHour?: number | null;
  goalEntityId?: number | null;
};

export default class TrackersDAL {
  private db: DrizzleD1Database;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  async createTracker(params: CreateTrackerParams) {
    const response: Schemas.ApiResponse & { tracker?: Schemas.Tracker } = { isSuccess: false };

    try {
      const now = new Date();
      const trackerResponse = await this.db
        .insert(trackers)
        .values({
          publicId: Utility.generatePublicId("trk_"),
          userId: params.userId,
          name: params.name,
          icon: params.icon ?? null,
          colorIndex: params.colorIndex ?? null,
          primaryMetricId: params.primaryMetricId,
          manifestJson: params.manifest,
          manifestVersion: 1,
          sortOrder: params.sortOrder ?? 0,
          activeFrom: params.activeFrom,
          activeTo: params.activeTo ?? null,
          reminderHour: params.reminderHour ?? null,
          goalEntityId: params.goalEntityId ?? null,
          createdAt: now,
          updatedAt: null,
        })
        .returning()
        .get();

      response.isSuccess = true;
      response.message = "Tracker created successfully";
      response.tracker = this.toTracker(trackerResponse);
    } catch (error) {
      const message = "Unknown error in creating tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: partial by construction, like EntitiesDAL.updateEntity — only the fields the caller
  // sent are written, so renaming a tracker can't blank an icon the form never showed. The manifest
  // arrives whole (the Repo merges it onto the stored one), because manifest_json is a single
  // column: a partial write here would drop control/metrics/compute.
  async updateTracker(params: {
    userId: string;
    publicId: string;
    fields: {
      name?: string;
      icon?: string | null;
      colorIndex?: number | null;
      manifest?: Schemas.TrackerManifest;
      sortOrder?: number;
      activeFrom?: string;
      reminderHour?: number | null;
      goalEntityId?: number | null;
    };
  }) {
    const response: Schemas.ApiResponse & { tracker?: Schemas.Tracker } = { isSuccess: false };

    try {
      const { manifest, ...columns } = params.fields;
      const trackerResponse = await this.db
        .update(trackers)
        .set({
          ...columns,
          ...(manifest ? { manifestJson: manifest } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackers.publicId, params.publicId),
            eq(trackers.userId, params.userId),
            isNull(trackers.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!trackerResponse) {
        const message = "Tracker not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateTracker,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tracker updated successfully";
      response.tracker = this.toTracker(trackerResponse);
    } catch (error) {
      const message = "Unknown error in updating tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getTracker(params: { userId: string; publicId: string }) {
    const response: Schemas.ApiResponse & { tracker?: Schemas.Tracker } = { isSuccess: false };

    try {
      const [tracker] = await this.db
        .select()
        .from(trackers)
        .where(
          and(
            eq(trackers.publicId, params.publicId),
            eq(trackers.userId, params.userId),
            isNull(trackers.deletedAt),
          ),
        )
        .limit(1);

      if (!tracker) {
        const message = "Tracker not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetTrackerDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tracker fetched successfully";
      response.tracker = this.toTracker(tracker);
    } catch (error) {
      const message = "Unknown error in fetching tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetTrackerDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: archiving is the only "delete" a client can do to a tracker, so the default list never
  // surfaces one again — but `archived: true` returns exactly those, which is what the restore
  // screen reads. Soft-deleted rows stay invisible to both (invariant 9 keeps them, nothing shows
  // them).
  async getTrackers(params: { userId: string; archived?: boolean }) {
    const response: Schemas.ApiResponse & { trackers?: Schemas.Tracker[] } = { isSuccess: false };

    try {
      const trackersResponse = await this.db
        .select()
        .from(trackers)
        .where(
          and(
            eq(trackers.userId, params.userId),
            params.archived ? isNotNull(trackers.archivedAt) : isNull(trackers.archivedAt),
            isNull(trackers.deletedAt),
          ),
        )
        .orderBy(asc(trackers.sortOrder), asc(trackers.id));

      response.isSuccess = true;
      response.message = "Trackers fetched successfully";
      response.trackers = trackersResponse.map((tracker) => this.toTracker(tracker));
    } catch (error) {
      const message = "Unknown error in listing trackers";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetTrackers,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async archiveTracker(params: { userId: string; publicId: string; activeTo: string }) {
    const response: Schemas.ApiResponse & { tracker?: Schemas.Tracker } = { isSuccess: false };

    try {
      const now = new Date();
      const trackerResponse = await this.db
        .update(trackers)
        .set({ archivedAt: now, activeTo: params.activeTo, updatedAt: now })
        .where(
          and(
            eq(trackers.publicId, params.publicId),
            eq(trackers.userId, params.userId),
            isNull(trackers.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!trackerResponse) {
        const message = "Tracker not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.ArchiveTracker,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tracker archived successfully";
      response.tracker = this.toTracker(trackerResponse);
    } catch (error) {
      const message = "Unknown error in archiving tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ArchiveTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: the inverse of archiveTracker, and it has to clear BOTH columns that method sets —
  // archived_at hides the row, but active_to is what tells the heatmap the tracker stopped being
  // active on that date. Restoring one without the other gives you a tracker that lists fine and
  // renders a dead history.
  //
  // DEV_NOTE: guarded on archived_at IS NOT NULL, so restoring an already-live tracker is a "not
  // found" no-op rather than a silent timestamp rewrite.
  async unarchiveTracker(params: { userId: string; publicId: string }) {
    const response: Schemas.ApiResponse & { tracker?: Schemas.Tracker } = { isSuccess: false };

    try {
      const now = new Date();
      const trackerResponse = await this.db
        .update(trackers)
        .set({ archivedAt: null, activeTo: null, updatedAt: now })
        .where(
          and(
            eq(trackers.publicId, params.publicId),
            eq(trackers.userId, params.userId),
            isNotNull(trackers.archivedAt),
            isNull(trackers.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!trackerResponse) {
        const message = "Archived tracker not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UnarchiveTracker,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tracker restored successfully";
      response.tracker = this.toTracker(trackerResponse);
    } catch (error) {
      const message = "Unknown error in restoring tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UnarchiveTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: one statement, not a loop over unarchiveTracker — "restore everything" is a single
  // user intent and a per-row fan-out against a remote D1 binding would be N round trips for it.
  async unarchiveAllTrackers(params: { userId: string }) {
    const response: Schemas.ApiResponse & { restoredCount?: number } = { isSuccess: false };

    try {
      const now = new Date();
      const restored = await this.db
        .update(trackers)
        .set({ archivedAt: null, activeTo: null, updatedAt: now })
        .where(
          and(
            eq(trackers.userId, params.userId),
            isNotNull(trackers.archivedAt),
            isNull(trackers.deletedAt),
          ),
        )
        .returning();

      response.isSuccess = true;
      response.message = "Trackers restored successfully";
      response.restoredCount = restored.length;
    } catch (error) {
      const message = "Unknown error in restoring trackers";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UnarchiveTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: invariant 9 — soft delete only. Cascading to this tracker's entries/entry_values/
  // entry_entities is the caller's job (architecture.md §4.1 point 4 — "cascade deletes are now
  // manual"), not this DAL's — EntriesDAL owns entries.
  async deleteTracker(params: { userId: string; publicId: string }) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const now = new Date();
      const deleted = await this.db
        .update(trackers)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(trackers.publicId, params.publicId),
            eq(trackers.userId, params.userId),
            isNull(trackers.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!deleted) {
        const message = "Tracker not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteTracker,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tracker deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting tracker";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteTracker,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: one `db.batch` call, not N sequential updates — each row gets a different sortOrder,
  // so this can't be the single "same value for every matching row" statement unarchiveAllTrackers
  // uses. D1's batch runs every statement in one atomic round trip, which is what keeps two trackers
  // from momentarily sharing a position if the worker were killed mid-loop.
  async reorderTrackers(params: { userId: string; order: { id: number; sortOrder: number }[] }) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    if (params.order.length === 0) {
      response.isSuccess = true;
      response.message = "Trackers reordered successfully";
      return response;
    }

    try {
      const now = new Date();
      const statements = params.order.map(({ id, sortOrder }) =>
        this.db
          .update(trackers)
          .set({ sortOrder, updatedAt: now })
          .where(
            and(
              eq(trackers.id, id),
              eq(trackers.userId, params.userId),
              isNull(trackers.deletedAt),
            ),
          ),
      );
      const [first, ...rest] = statements;
      await this.db.batch([first, ...rest]);

      response.isSuccess = true;
      response.message = "Trackers reordered successfully";
    } catch (error) {
      const message = "Unknown error in reordering trackers";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ReorderTrackers,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // --- target history --------------------------------------------------------------------------

  // DEV_NOTE: an upsert on (tracker_id, effective_from), not a plain insert — "set a target from
  // today" is an idempotent statement about a day, and a user who changes their mind twice in one
  // afternoon is correcting today's row, not stacking a second one the unique index would reject.
  // The whole point of this table is that yesterday's rows are immutable; today's is not yet
  // history.
  async createTrackerTarget(params: {
    userId: string;
    trackerId: number;
    effectiveFrom: string;
    target: number | null;
  }) {
    const response: Schemas.ApiResponse & { target?: Schemas.TrackerTarget } = { isSuccess: false };

    try {
      const now = new Date();
      const [existing] = await this.db
        .select()
        .from(trackerTargets)
        .where(
          and(
            eq(trackerTargets.trackerId, params.trackerId),
            eq(trackerTargets.userId, params.userId),
            eq(trackerTargets.effectiveFrom, params.effectiveFrom),
            isNull(trackerTargets.deletedAt),
          ),
        )
        .limit(1);

      const row = existing
        ? await this.db
            .update(trackerTargets)
            .set({ target: params.target, updatedAt: now })
            .where(eq(trackerTargets.id, existing.id))
            .returning()
            .get()
        : await this.db
            .insert(trackerTargets)
            .values({
              publicId: Utility.generatePublicId("trt_"),
              userId: params.userId,
              trackerId: params.trackerId,
              effectiveFrom: params.effectiveFrom,
              target: params.target,
              createdAt: now,
              updatedAt: null,
            })
            .returning()
            .get();

      response.isSuccess = true;
      response.message = "Target saved successfully";
      response.target = row;
    } catch (error) {
      const message = "Unknown error in saving tracker target";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateTrackerTarget,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: ascending by effectiveFrom, always the whole history — every caller resolves "the
  // target on day D" by walking it, and a walk needs the rows in order. Small by construction: a
  // row exists per target *change*, not per day.
  async getTrackerTargets(params: { userId: string; trackerId: number }) {
    const response: Schemas.ApiResponse & { targets?: Schemas.TrackerTarget[] } = {
      isSuccess: false,
    };

    try {
      const targets = await this.db
        .select()
        .from(trackerTargets)
        .where(
          and(
            eq(trackerTargets.trackerId, params.trackerId),
            eq(trackerTargets.userId, params.userId),
            isNull(trackerTargets.deletedAt),
          ),
        )
        .orderBy(asc(trackerTargets.effectiveFrom));

      response.isSuccess = true;
      response.message = "Targets fetched successfully";
      response.targets = targets;
    } catch (error) {
      const message = "Unknown error in listing tracker targets";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetTrackerTargets,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: the Today screen scores N trackers' streaks in one pass, so it needs every tracker's
  // history in one query rather than N — the same reason getDailyFactsForMetrics exists. Internal,
  // DAL-to-Repo, so taking ids is fine (invariant 11 is about the API boundary).
  async getTrackerTargetsForTrackers(params: { userId: string; trackerIds: number[] }) {
    const response: Schemas.ApiResponse & { targets?: Schemas.TrackerTarget[] } = {
      isSuccess: false,
    };

    if (params.trackerIds.length === 0) {
      response.isSuccess = true;
      response.message = "Targets fetched successfully";
      response.targets = [];
      return response;
    }

    try {
      // Chunked for D1's 100-bound-parameter cap — the list grows with the user's tracker count.
      const targets: Schemas.TrackerTarget[] = [];
      for (const ids of Utility.chunk(params.trackerIds)) {
        const rows = await this.db
          .select()
          .from(trackerTargets)
          .where(
            and(
              eq(trackerTargets.userId, params.userId),
              inArray(trackerTargets.trackerId, ids),
              isNull(trackerTargets.deletedAt),
            ),
          )
          .orderBy(asc(trackerTargets.effectiveFrom));
        targets.push(...rows);
      }

      response.isSuccess = true;
      response.message = "Targets fetched successfully";
      response.targets = targets;
    } catch (error) {
      const message = "Unknown error in listing tracker targets";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetTrackerTargets,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: invariant 9 — soft delete only. Scoped by trackerId as well as userId so a publicId
  // belonging to another tracker of the same user can't be deleted through this tracker's route.
  async deleteTrackerTarget(params: { userId: string; trackerId: number; publicId: string }) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const now = new Date();
      const deleted = await this.db
        .update(trackerTargets)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(trackerTargets.publicId, params.publicId),
            eq(trackerTargets.trackerId, params.trackerId),
            eq(trackerTargets.userId, params.userId),
            isNull(trackerTargets.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!deleted) {
        const message = "Target not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteTrackerTarget,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Target deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting tracker target";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteTrackerTarget,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: drizzle's json-mode column types manifestJson as TrackerManifest | null at the
  // select level even though the column is notNull — narrow it back for callers.
  private toTracker(row: typeof trackers.$inferSelect): Schemas.Tracker {
    const { manifestJson, ...rest } = row;
    return { ...rest, manifest: manifestJson as Schemas.TrackerManifest };
  }
}
