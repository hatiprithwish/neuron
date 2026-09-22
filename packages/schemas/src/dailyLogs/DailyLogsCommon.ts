import { z } from "zod";

// DEV_NOTE: a daily log is one free-form note per calendar day — the user's own words about the
// day, written in a Notion-style block editor (Tiptap). Nothing reads the content yet; it is kept as
// the editor's structured JSON rather than HTML or markdown so a later parsing pass gets the block
// structure (headings, to-dos, quotes) without having to re-derive it from text.

export const ZLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// DEV_NOTE: the ProseMirror/Tiptap JSON document shape (Tiptap's own `JSONContent`), validated
// structurally only — which node and mark names are legal is the editor's schema to decide, not the
// API's, so adding an editor extension never needs an API change. Unknown keys are stripped.
export const ZTiptapMark = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});
export type TiptapMark = z.infer<typeof ZTiptapMark>;

export const ZTiptapNode = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  marks: z.array(ZTiptapMark).optional(),
  text: z.string().optional(),
  get content(): z.ZodOptional<z.ZodArray<typeof ZTiptapNode>> {
    return z.array(ZTiptapNode).optional();
  },
});
export type TiptapNode = z.infer<typeof ZTiptapNode>;

// DEV_NOTE: ~200KB of serialized JSON — several thousand words of a single day's note, far past
// anything a person writes in a day, and well inside a D1 row. The cap exists to stop a runaway
// client, not to ration the user.
export const DAILY_LOG_MAX_CONTENT_CHARS = 200_000;

export const ZTiptapDoc = ZTiptapNode.extend({ type: z.literal("doc") }).refine(
  (doc) => JSON.stringify(doc).length <= DAILY_LOG_MAX_CONTENT_CHARS,
  { message: "Daily log is too long" },
);
export type TiptapDoc = z.infer<typeof ZTiptapDoc>;

// Whole Daily Log Body — DB shape
// DEV_NOTE: id is the internal PK — never sent to a client. The client addresses a log by its
// localDate (one per user per day); publicId is its stable client-facing identity.
export const ZDailyLog = z.object({
  id: z.number(),
  publicId: z.string(),
  userId: z.string(),
  localDate: ZLocalDate,
  tz: z.string(),
  contentJson: ZTiptapDoc,
  // DEV_NOTE: plain-text projection of contentJson, derived server-side on every write — backs list
  // previews today and search/parsing later without re-walking the JSON.
  contentText: z.string(),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
  deletedAt: z.date().nullable().optional(),
});
export type DailyLog = z.infer<typeof ZDailyLog>;

// API response shape — id/deletedAt structurally omitted, publicId is client-facing
export type DailyLogApiShape = Omit<DailyLog, "id" | "deletedAt">;

// DEV_NOTE: the list view never needs the document itself — only enough text to recognise the day.
// Sending every day's full JSON to render a column of one-line previews would be the whole archive
// on every visit.
export type DailyLogSummaryApiShape = Pick<
  DailyLog,
  "publicId" | "localDate" | "createdAt" | "updatedAt"
> & {
  preview: string;
};

// DAL list-row shape — the columns the list reads, contentJson deliberately not among them.
export type DailyLogSummaryRow = Pick<
  DailyLog,
  "publicId" | "localDate" | "contentText" | "createdAt" | "updatedAt"
>;
