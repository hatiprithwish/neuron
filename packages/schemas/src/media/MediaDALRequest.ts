import type { Media } from "./MediaCommon";

export type CreateMediaDALRequest = Pick<
  Media,
  "userId" | "r2Key" | "contentType" | "bytes" | "width" | "height"
> & { publicId: string };

export type FindMediaDALRequest = Pick<Media, "publicId">;

export type GetMediaByPublicIdsDALRequest = Pick<Media, "userId"> & { publicIds: string[] };

export type DeleteMediaDALRequest = Pick<Media, "userId"> & { publicIds: string[] };
