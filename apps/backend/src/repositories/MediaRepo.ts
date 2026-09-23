import MediaDAL from "@/data-access-layer/MediaDAL";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

export default class MediaRepo {
  private dal: MediaDAL;
  private env: Env;

  constructor(env: Env) {
    this.dal = new MediaDAL(env);
    this.env = env;
  }

  private toApiShape(media: Schemas.Media, origin: string): Schemas.MediaApiShape {
    const { id: _id, userId: _userId, r2Key: _r2Key, deletedAt: _deletedAt, ...rest } = media;
    return { ...rest, url: `${origin}/media/${media.publicId}` };
  }

  // DEV_NOTE: one transformation per upload and none per read — the stored object is already the
  // derivative the editor displays (MEDIA_MAX_WIDTH, WebP). Cloudflare Images bills a unique
  // transformation once per calendar month, and the Free plan allows 5,000, so a journal's uploads
  // sit far inside it. .info() is free, and it's the only way to learn the stored dimensions.
  //
  // DEV_NOTE: the bytes are read into memory once and re-streamed twice (info, then input) —
  // a ReadableStream can only be consumed once, and both calls need the whole image.
  private async optimize(
    bytes: ArrayBuffer,
    contentType: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
    try {
      const transformed = await this.env.IMAGES.input(streamOf(bytes))
        .transform({ width: Schemas.MEDIA_MAX_WIDTH, fit: "scale-down" })
        .output({
          format: Schemas.MEDIA_OUTPUT_FORMAT,
          quality: Schemas.MEDIA_OUTPUT_QUALITY,
        });

      return { body: transformed.image(), contentType: transformed.contentType() };
    } catch (error) {
      // DEV_NOTE: not fatal — over the Free plan's 5,000 unique transformations Images returns
      // 9422, and an upload failing because an optimisation failed would be the wrong trade. The
      // original bytes are stored instead, at their own size and type.
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.UploadMedia,
        message: "Image optimisation failed, storing the original",
        error,
        metadata: { contentType },
      });
      return null;
    }
  }

  private async readDimensions(
    bytes: ArrayBuffer,
  ): Promise<{ width: number | null; height: number | null }> {
    try {
      const info = await this.env.IMAGES.info(streamOf(bytes));
      return "width" in info
        ? { width: info.width, height: info.height }
        : {
            width: null,
            height: null,
          };
    } catch {
      // DEV_NOTE: dimensions are a nicety (they let the editor reserve space) — never a reason to
      // refuse an upload that is otherwise fine.
      return { width: null, height: null };
    }
  }

  async uploadMedia(params: {
    userId: string;
    file: File;
    origin: string;
  }): Promise<Schemas.UploadMediaApiResponse> {
    const typeResult = Schemas.ZUploadType.safeParse(params.file.type);
    if (!typeResult.success) {
      return { isSuccess: false, message: "That file type isn't supported" };
    }
    if (params.file.size > Schemas.MAX_UPLOAD_BYTES) {
      const limitMb = Math.round(Schemas.MAX_UPLOAD_BYTES / (1024 * 1024));
      return { isSuccess: false, message: `Images have to be under ${limitMb}MB` };
    }

    const publicId = Utility.generatePublicId("med_");
    const sourceBytes = await params.file.arrayBuffer();

    const optimized = await this.optimize(sourceBytes, typeResult.data);
    const dimensions = await this.readDimensions(sourceBytes);

    const r2Key = `media/${params.userId}/${publicId}`;
    const contentType = optimized?.contentType ?? typeResult.data;

    try {
      // DEV_NOTE: R2 first, the row second — a row is only written once the bytes are really
      // there, so a URL in a document can never point at nothing.
      const stored = await this.env.MEDIA.put(r2Key, optimized?.body ?? sourceBytes, {
        httpMetadata: { contentType },
      });

      const created = await this.dal.createMedia({
        publicId,
        userId: params.userId,
        r2Key,
        contentType,
        bytes: stored?.size ?? params.file.size,
        width: dimensions.width,
        height: dimensions.height,
      });

      if (!created.isSuccess || !created.media) {
        // DEV_NOTE: the row failed, so nothing will ever reference these bytes — take them back
        // out rather than leaving an object the cleanup can't see.
        await this.env.MEDIA.delete(r2Key);
        return { isSuccess: false, message: created.message };
      }

      return {
        isSuccess: true,
        message: "Image uploaded successfully",
        media: this.toApiShape(created.media, params.origin),
      };
    } catch (error) {
      const message = "Unknown error in uploading image";
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.UploadMedia,
        message,
        error,
        metadata: { userId: params.userId, r2Key },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: returns the body and its headers rather than a Response — building the HTTP reply is
  // the route's job, not the repository's.
  async getMediaBody(params: { publicId: string }): Promise<{
    isSuccess: boolean;
    message?: string;
    isNotFound?: boolean;
    body?: ReadableStream<Uint8Array>;
    contentType?: string;
    bytes?: number;
  }> {
    const found = await this.dal.getMedia({ publicId: params.publicId });
    if (!found.isSuccess) return { isSuccess: false, message: found.message };
    if (!found.media) return { isSuccess: false, isNotFound: true, message: "Image not found" };

    try {
      const object = await this.env.MEDIA.get(found.media.r2Key);
      if (!object) {
        AppLogger.error({
          category: Schemas.LogCategory.Repo,
          action: Schemas.LogAction.GetMedia,
          message: "Media row has no object in R2",
          metadata: { publicId: params.publicId, r2Key: found.media.r2Key },
        });
        return { isSuccess: false, isNotFound: true, message: "Image not found" };
      }

      return {
        isSuccess: true,
        body: object.body,
        contentType: found.media.contentType,
        bytes: found.media.bytes,
      };
    } catch (error) {
      const message = "Unknown error in fetching image";
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.GetMedia,
        message,
        error,
        metadata: { publicId: params.publicId },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: the cleanup path, called by DailyLogsRepo when a document stops referencing an image
  // (and when a whole day is deleted). Owner-scoped through the DAL, so a URL copied from someone
  // else's note can't delete their image. The R2 object goes for real — reclaiming the bytes is
  // the point — while the row is soft-deleted like everything else (invariant 9).
  async deleteMediaByPublicIds(params: {
    userId: string;
    publicIds: string[];
  }): Promise<Schemas.ApiResponse> {
    if (params.publicIds.length === 0) return { isSuccess: true, message: "Nothing to delete" };

    const found = await this.dal.getMediaByPublicIds(params);
    if (!found.isSuccess) return { isSuccess: false, message: found.message };

    const owned = found.media ?? [];
    if (owned.length === 0) return { isSuccess: true, message: "Nothing to delete" };

    const deleted = await this.dal.deleteMedia({
      userId: params.userId,
      publicIds: owned.map((media) => media.publicId),
    });
    if (!deleted.isSuccess) return { isSuccess: false, message: deleted.message };

    try {
      await this.env.MEDIA.delete(owned.map((media) => media.r2Key));
    } catch (error) {
      // DEV_NOTE: the rows are already soft-deleted, so the images are unreachable either way —
      // this logs the leaked object rather than failing a save the user already made.
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.DeleteMedia,
        message: "Media rows deleted but their R2 objects were not",
        error,
        metadata: { userId: params.userId, keys: owned.map((media) => media.r2Key) },
      });
    }

    return { isSuccess: true, message: "Media deleted successfully" };
  }
}

// DEV_NOTE: the Images binding takes a ReadableStream; Response is the shortest way to make one
// from bytes already in memory without pulling in a stream helper.
function streamOf(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}
