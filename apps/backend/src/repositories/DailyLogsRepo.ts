import DailyLogsDAL from "@/data-access-layer/DailyLogsDAL";
import UsersDAL from "@/data-access-layer/UsersDAL";
import MediaRepo from "@/repositories/MediaRepo";
import { localDateIn } from "@/utils/DateTime";
import { collectMediaPublicIds, docToPlainText, plainTextPreview } from "@/utils/DocumentText";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: same fallback as TrackersRepo — users.tz decides which calendar day is "today"
// (architecture.md §4 invariant 4), and an unreadable users row degrades to the UTC boundary
// rather than failing the save outright.
const FALLBACK_TZ = "UTC";

// DEV_NOTE: a little over a year — enough for the list to cover any "what was I doing last
// spring" scroll, bounded so one request is one bounded index range, not the whole history.
const MAX_RANGE_DAYS = 400;

const DAY_MS = 1000 * 60 * 60 * 24;

export default class DailyLogsRepo {
  private dailyLogsDal: DailyLogsDAL;
  private usersDal: UsersDAL;
  private mediaRepo: MediaRepo;

  constructor(env: Env) {
    this.dailyLogsDal = new DailyLogsDAL(env);
    this.usersDal = new UsersDAL(env);
    this.mediaRepo = new MediaRepo(env);
  }

  // DEV_NOTE: the document is the only record of what an image is attached to, so every write
  // compares the images the day referenced before against the ones it references now, and the
  // difference is an upload nothing points at any more. Removing an image from a note therefore
  // reclaims its bytes instead of leaving them in R2 forever.
  // DEV_NOTE: never fails the save. The note is what the user wrote; a stranded object is a
  // storage cost, and refusing their words to report one would be the wrong trade.
  private async releaseUnreferencedMedia(params: {
    userId: string;
    previous: Schemas.DailyLog | null;
    next: Schemas.TiptapDoc | null;
  }): Promise<void> {
    if (!params.previous) return;

    const before = collectMediaPublicIds(params.previous.contentJson);
    if (before.length === 0) return;

    const after = new Set(params.next ? collectMediaPublicIds(params.next) : []);
    const orphaned = before.filter((publicId) => !after.has(publicId));
    if (orphaned.length === 0) return;

    await this.mediaRepo.deleteMediaByPublicIds({ userId: params.userId, publicIds: orphaned });
  }

  private async resolveTz(userId: string): Promise<string> {
    const result = await this.usersDal.getUserDetails({ clerkId: userId });
    return result.user?.tz ?? FALLBACK_TZ;
  }

  // DEV_NOTE: invariant 11 — id never leaves the server.
  private toApiShape(dailyLog: Schemas.DailyLog): Schemas.DailyLogApiShape {
    const { id: _id, deletedAt: _deletedAt, ...rest } = dailyLog;
    return rest;
  }

  private toSummaryApiShape(row: Schemas.DailyLogSummaryRow): Schemas.DailyLogSummaryApiShape {
    const { contentText, ...rest } = row;
    return { ...rest, preview: plainTextPreview(contentText) };
  }

  async getDailyLog(params: {
    userId: string;
    localDate: string;
  }): Promise<Schemas.GetDailyLogApiResponse> {
    const result = await this.dailyLogsDal.getDailyLog(params);
    if (!result.isSuccess) return { isSuccess: false, message: result.message };

    return {
      isSuccess: true,
      message: result.message,
      dailyLog: result.dailyLog ? this.toApiShape(result.dailyLog) : null,
    };
  }

  // DEV_NOTE: a day that hasn't happened yet in the owner's zone is refused — a daily log is a
  // record of a day lived, and a note filed under tomorrow would sit in the list as a day that
  // already has something written about it. Past days are fine: writing up yesterday is normal.
  // DEV_NOTE: a document with no text (cleared editor, or only a divider left) removes the day's
  // log instead of saving a blank row — see UpsertDailyLogApiResponse. Removing a day that was
  // never written is not an error here; the caller just cleared an editor that was already empty.
  async upsertDailyLog(params: {
    userId: string;
    localDate: string;
    body: Schemas.UpsertDailyLogApiRequest;
  }): Promise<Schemas.UpsertDailyLogApiResponse> {
    const tz = await this.resolveTz(params.userId);

    if (params.localDate > localDateIn(tz, new Date())) {
      return { isSuccess: false, message: "Can't write a log for a day that hasn't happened yet" };
    }

    const contentText = docToPlainText(params.body.contentJson);

    // DEV_NOTE: read before write — the previous document is what the image cleanup diffs against,
    // and after the upsert it is gone.
    const existing = await this.dailyLogsDal.getDailyLog({
      userId: params.userId,
      localDate: params.localDate,
    });
    if (!existing.isSuccess) return { isSuccess: false, message: existing.message };

    if (contentText === "") {
      if (existing.dailyLog) {
        const deleted = await this.dailyLogsDal.deleteDailyLog({
          userId: params.userId,
          localDate: params.localDate,
        });
        if (!deleted.isSuccess) return { isSuccess: false, message: deleted.message };

        await this.releaseUnreferencedMedia({
          userId: params.userId,
          previous: existing.dailyLog,
          next: null,
        });
      }

      return { isSuccess: true, message: "Daily log cleared", dailyLog: null };
    }

    const result = await this.dailyLogsDal.upsertDailyLog({
      userId: params.userId,
      localDate: params.localDate,
      tz,
      contentJson: params.body.contentJson,
      contentText,
    });
    if (!result.isSuccess || !result.dailyLog) {
      return { isSuccess: false, message: result.message };
    }

    await this.releaseUnreferencedMedia({
      userId: params.userId,
      previous: existing.dailyLog ?? null,
      next: params.body.contentJson,
    });

    return {
      isSuccess: true,
      message: result.message,
      dailyLog: this.toApiShape(result.dailyLog),
    };
  }

  async getDailyLogs(params: {
    userId: string;
    from: string;
    to: string;
  }): Promise<Schemas.GetDailyLogsApiResponse> {
    const spanDays = (Date.parse(params.to) - Date.parse(params.from)) / DAY_MS;
    if (spanDays > MAX_RANGE_DAYS) {
      return { isSuccess: false, message: `Range can't be longer than ${MAX_RANGE_DAYS} days` };
    }

    const result = await this.dailyLogsDal.getDailyLogs(params);
    if (!result.isSuccess) return { isSuccess: false, message: result.message };

    return {
      isSuccess: true,
      message: result.message,
      dailyLogs: (result.dailyLogs ?? []).map((row) => this.toSummaryApiShape(row)),
    };
  }

  async deleteDailyLog(params: {
    userId: string;
    localDate: string;
  }): Promise<Schemas.ApiResponse> {
    return await this.dailyLogsDal.deleteDailyLog(params);
  }
}
