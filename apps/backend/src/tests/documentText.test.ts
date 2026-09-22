import { describe, it, expect } from "vitest";
import { docToPlainText, plainTextPreview } from "@/utils/DocumentText";
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
