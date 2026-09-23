import { z } from "zod";

// DEV_NOTE: user-uploaded binary, stored in R2 and addressed by an unguessable publicId — the URL
// is the credential (GET /media/:publicId is unauthenticated, because <img src> can't carry a
// bearer token and the API is a different origin from the web app, so no cookie rides along
// either). One row per stored object; the daily log's document JSON references it by URL.

// DEV_NOTE: what a client may upload. SVG is deliberately absent — it can carry script, and it
// would be served from the API's own origin. HEIC is here because that's what iPhones produce;
// Cloudflare Images ingests it and the stored derivative is WebP like everything else.
export const ALLOWED_UPLOAD_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;
export const ZUploadType = z.enum(ALLOWED_UPLOAD_TYPES);
export type UploadType = z.infer<typeof ZUploadType>;

// DEV_NOTE: the Images binding accepts 20MB into .input(); this is the cap on what the route will
// take at all, low enough that a stray video or a RAW file is refused before any work happens.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// DEV_NOTE: every upload is downscaled to this width and re-encoded as WebP once, at upload time
// (MediaRepo) — reads never transform, so serving is free of Images usage. WebP rather than AVIF:
// AVIF output is capped at 1,200px per dimension, needs Safari 16.4+, and Cloudflare silently
// falls back to WebP or JPEG when an AVIF encode would be too slow. One stored derivative has to
// decode everywhere, so it's WebP.
export const MEDIA_MAX_WIDTH = 1600;
export const MEDIA_OUTPUT_FORMAT = "image/webp";
export const MEDIA_OUTPUT_QUALITY = 82;

export const ZMedia = z.object({
  id: z.number(),
  publicId: z.string(),
  userId: z.string(),
  r2Key: z.string(),
  contentType: z.string(),
  bytes: z.number(),
  // DEV_NOTE: dimensions of the stored derivative, read for free from the binding's .info() and
  // written into the editor's image node so the page reserves the right space before it loads.
  width: z.number().nullable(),
  height: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
  deletedAt: z.date().nullable().optional(),
});
export type Media = z.infer<typeof ZMedia>;

// API response shape — id/userId/r2Key never cross the boundary; `url` is what a client uses.
export type MediaApiShape = Omit<Media, "id" | "userId" | "r2Key" | "deletedAt"> & {
  url: string;
};

// DEV_NOTE: the document stores absolute URLs, so cleanup has to map a URL back to the row it
// came from. Kept here, beside the shape that produced it, so the two can't drift.
export function mediaPublicIdFromUrl(url: string): string | null {
  const match = /\/media\/(med_[A-Za-z0-9_-]+)(?:[?#]|$)/.exec(url);
  return match?.[1] ?? null;
}
