import { describe, it, expect } from "vitest";
import { collectMediaPublicIds, docToPlainText, plainTextPreview } from "@/utils/DocumentText";
import * as Schemas from "@app/schemas";

const paragraph = (text: string): Schemas.TiptapNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("docToPlainText", () => {
  it("puts each block on its own line and keeps inline marks' text contiguous", () => {
    const doc: Schemas.TiptapDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Tuesday" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "slept " },
            { type: "text", text: "badly", marks: [{ type: "bold" }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [paragraph("run")] },
            { type: "taskItem", attrs: { checked: false }, content: [paragraph("call mum")] },
          ],
        },
      ],
    };

    expect(docToPlainText(doc)).toBe("Tuesday\nslept badly.\nrun\ncall mum");
  });

  it("turns a hard break into a line break inside the same block", () => {
    const doc: Schemas.TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "one" },
            { type: "hardBreak" },
            { type: "text", text: "two" },
          ],
        },
      ],
    };

    expect(docToPlainText(doc)).toBe("one\ntwo");
  });

  // DEV_NOTE: this is what DailyLogsRepo reads as "the editor was cleared" — an empty doc, empty
  // paragraphs, or only a divider must all project to "" so the day's log is removed, not saved blank.
  it("projects documents with no words to an empty string", () => {
    expect(docToPlainText({ type: "doc" })).toBe("");
    expect(docToPlainText({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
    expect(
      docToPlainText({
        type: "doc",
        content: [{ type: "paragraph" }, { type: "horizontalRule" }, { type: "paragraph" }],
      }),
    ).toBe("");
  });
});

describe("plainTextPreview", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(plainTextPreview("Tuesday\n\nslept   badly")).toBe("Tuesday slept badly");
    expect(plainTextPreview("a".repeat(300), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("ZTiptapDoc", () => {
  it("accepts nested editor JSON and rejects a non-doc root", () => {
    expect(
      Schemas.ZTiptapDoc.safeParse({
        type: "doc",
        content: [
          { type: "bulletList", content: [{ type: "listItem", content: [paragraph("x")] }] },
        ],
      }).success,
    ).toBe(true);
    expect(Schemas.ZTiptapDoc.safeParse(paragraph("x")).success).toBe(false);
  });

  it("rejects a document past the size cap", () => {
    const huge = paragraph("x".repeat(Schemas.DAILY_LOG_MAX_CONTENT_CHARS));
    expect(Schemas.ZTiptapDoc.safeParse({ type: "doc", content: [huge] }).success).toBe(false);
  });
});

describe("collectMediaPublicIds", () => {
  const imageDoc = (...srcs: string[]): Schemas.TiptapDoc => ({
    type: "doc",
    content: srcs.map((src) => ({ type: "image", attrs: { src } })),
  });

  it("finds media ids behind image URLs, wherever they are nested", () => {
    const doc: Schemas.TiptapDoc = {
      type: "doc",
      content: [
        paragraph("before"),
        {
          type: "blockquote",
          content: [{ type: "image", attrs: { src: "https://api.example.com/media/med_abc123" } }],
        },
        { type: "image", attrs: { src: "https://api.example.com/media/med_def456" } },
      ],
    };

    expect(docToPlainText(doc)).toBe("before");
    expect(collectMediaPublicIds(doc).sort()).toEqual(["med_abc123", "med_def456"]);
  });

  it("de-duplicates the same image used twice and ignores foreign URLs", () => {
    const doc = imageDoc(
      "https://api.example.com/media/med_abc123",
      "https://api.example.com/media/med_abc123",
      "https://images.example.net/cat.png",
      "blob:http://localhost:3000/9f1c-uploading",
    );

    expect(collectMediaPublicIds(doc)).toEqual(["med_abc123"]);
  });

  // DEV_NOTE: this difference is exactly what DailyLogsRepo deletes — an image dropped from a note
  // between two saves.
  it("gives the repo the set difference it deletes on", () => {
    const before = collectMediaPublicIds(
      imageDoc("https://api.example.com/media/med_kept", "https://api.example.com/media/med_gone"),
    );
    const after = new Set(
      collectMediaPublicIds(imageDoc("https://api.example.com/media/med_kept")),
    );

    expect(before.filter((publicId) => !after.has(publicId))).toEqual(["med_gone"]);
  });

  it("returns nothing for a document with no images", () => {
    expect(collectMediaPublicIds({ type: "doc", content: [paragraph("just words")] })).toEqual([]);
  });
});
