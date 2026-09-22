import type { DailyLog } from "./DailyLogsCommon";

export type UpsertDailyLogDALRequest = Pick<
  DailyLog,
  "userId" | "localDate" | "tz" | "contentJson" | "contentText"
>;

export type FindDailyLogDALRequest = Pick<DailyLog, "userId" | "localDate">;

export type GetDailyLogsDALRequest = Pick<DailyLog, "userId"> & { from: string; to: string };
