import type { DailyLogApiShape, DailyLogSummaryApiShape } from "./DailyLogsCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: dailyLog is null, not an error, when the day has no log — an unwritten day is the
// normal state of most days, and the client renders an empty editor rather than a failure.
export interface GetDailyLogApiResponse extends ApiResponse {
  dailyLog?: DailyLogApiShape | null;
}

// DEV_NOTE: dailyLog is null after a save that emptied the document — clearing the editor removes
// the day's log rather than keeping a blank row that would show up in the list as an empty entry.
export interface UpsertDailyLogApiResponse extends ApiResponse {
  dailyLog?: DailyLogApiShape | null;
}

export interface GetDailyLogsApiResponse extends ApiResponse {
  dailyLogs?: DailyLogSummaryApiShape[];
}
