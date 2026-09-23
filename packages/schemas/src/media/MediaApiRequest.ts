import { z } from "zod";

// DEV_NOTE: the upload body is multipart/form-data (a file, not JSON), so there's no Zod schema
// for it — MediaRepo validates the part's type and size instead. This is the param schema for the
// routes that address an existing object.
export const ZMediaPublicIdParam = z.object({ publicId: z.string() });
export type MediaPublicIdParam = z.infer<typeof ZMediaPublicIdParam>;

export const MEDIA_UPLOAD_FIELD = "file";
