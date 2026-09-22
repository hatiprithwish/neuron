import { z } from "zod";
import { ZLocalDate, ZTiptapDoc } from "./DailyLogsCommon";

export const ZDailyLogLocalDateParam = z.object({ localDate: ZLocalDate });
export type DailyLogLocalDateParam = z.infer<typeof ZDailyLogLocalDateParam>;

// DEV_NOTE: the whole document on every save, not a patch — one note per day, written by one
// person, so last-write-wins on the full doc is correct and a diff protocol would be ceremony.
export const ZUpsertDailyLogApiRequest = z.object({
  contentJson: ZTiptapDoc,
});
export type UpsertDailyLogApiRequest = z.infer<typeof ZUpsertDailyLogApiRequest>;

export const ZGetDailyLogsApiQuery = z
  .object({
    from: ZLocalDate,
    to: ZLocalDate,
  })
  .refine((query) => query.from <= query.to, { message: "`from` must be on or before `to`" });
export type GetDailyLogsApiQuery = z.infer<typeof ZGetDailyLogsApiQuery>;
