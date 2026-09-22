import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import getDbClient from "@/db/dbClient";
import { dailyLogs } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

export default class DailyLogsDAL {
  private db: DrizzleD1Database;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  // DEV_NOTE: onConflictDoUpdate on (user_id, local_date) — the partial unique index, deleted_at is
  // null — so the first save of a day inserts and every later save rewrites the same row, keeping
  // its publicId and createdAt. Same shape as NotificationsDAL.upsertPushSubscription.
  async upsertDailyLog(params: Schemas.UpsertDailyLogDALRequest) {
    const response: Schemas.ApiResponse & { dailyLog?: Schemas.DailyLog } = { isSuccess: false };

    try {
      const now = new Date();
      const dailyLogResponse = await this.db
        .insert(dailyLogs)
        .values({
          publicId: Utility.generatePublicId("dlg_"),
          userId: params.userId,
          localDate: params.localDate,
          tz: params.tz,
          contentJson: params.contentJson,
          contentText: params.contentText,
          createdAt: now,
          updatedAt: null,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: [dailyLogs.userId, dailyLogs.localDate],
          targetWhere: isNull(dailyLogs.deletedAt),
          set: {
            tz: params.tz,
            contentJson: params.contentJson,
            contentText: params.contentText,
            updatedAt: now,
          },
        })
        .returning()
        .get();

      response.isSuccess = true;
      response.message = "Daily log saved successfully";
      response.dailyLog = dailyLogResponse;
    } catch (error) {
      const message = "Unknown error in saving daily log";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpsertDailyLog,
        message,
        error,
        metadata: { userId: params.userId, localDate: params.localDate },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: a day with no log is a success with no row, not a "not found" failure — most days
  // start unwritten, and the caller renders an empty editor for them.
  async getDailyLog(params: Schemas.FindDailyLogDALRequest) {
    const response: Schemas.ApiResponse & { dailyLog?: Schemas.DailyLog | null } = {
      isSuccess: false,
    };

    try {
      const [dailyLog] = await this.db
        .select()
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.userId, params.userId),
            eq(dailyLogs.localDate, params.localDate),
            isNull(dailyLogs.deletedAt),
          ),
        )
        .limit(1);

      response.isSuccess = true;
      response.message = "Daily log fetched successfully";
      response.dailyLog = dailyLog ?? null;
    } catch (error) {
      const message = "Unknown error in fetching daily log";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDailyLog,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: selects contentText, never contentJson — the list renders one-line previews, and
  // pulling every day's document to do it would read the whole archive on each visit. Newest first,
  // since the day a person is most likely looking for is a recent one.
  async getDailyLogs(params: Schemas.GetDailyLogsDALRequest) {
    const response: Schemas.ApiResponse & { dailyLogs?: Schemas.DailyLogSummaryRow[] } = {
      isSuccess: false,
    };

    try {
      const dailyLogsResponse = await this.db
        .select({
          publicId: dailyLogs.publicId,
          localDate: dailyLogs.localDate,
          contentText: dailyLogs.contentText,
          createdAt: dailyLogs.createdAt,
          updatedAt: dailyLogs.updatedAt,
        })
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.userId, params.userId),
            gte(dailyLogs.localDate, params.from),
            lte(dailyLogs.localDate, params.to),
            isNull(dailyLogs.deletedAt),
          ),
        )
        .orderBy(desc(dailyLogs.localDate));

      response.isSuccess = true;
      response.message = "Daily logs fetched successfully";
      response.dailyLogs = dailyLogsResponse;
    } catch (error) {
      const message = "Unknown error in listing daily logs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDailyLogs,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: invariant 9 — soft delete only. No hard deletes, ever.
  async deleteDailyLog(params: Schemas.FindDailyLogDALRequest) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const now = new Date();
      const deleted = await this.db
        .update(dailyLogs)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(dailyLogs.userId, params.userId),
            eq(dailyLogs.localDate, params.localDate),
            isNull(dailyLogs.deletedAt),
          ),
        )
        .returning()
        .get();

      if (!deleted) {
        const message = "Daily log not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteDailyLog,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Daily log deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting daily log";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteDailyLog,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
