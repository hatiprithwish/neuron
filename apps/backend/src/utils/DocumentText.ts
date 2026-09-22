import type * as Schemas from "@app/schemas";

// DEV_NOTE: the plain-text projection of a Tiptap document stored as daily_logs.content_text. A
// textblock (paragraph, heading, a task item's paragraph) joins its inline children with nothing
// between them; every other container joins its children one per line, so a list reads as lines
// rather than one run-on sentence. hardBreak (shift+enter) is a line break inside a textblock.
function isInline(node: Schemas.TiptapNode): boolean {
  return node.type === "text" || node.type === "hardBreak";
}

function nodeToText(node: Schemas.TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";

  const children = node.content ?? [];
  const separator = children.some(isInline) ? "" : "\n";
  return children.map(nodeToText).join(separator);
}

export function docToPlainText(doc: Schemas.TiptapDoc): string {
  return nodeToText(doc)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// DEV_NOTE: one line for the list view — whitespace collapsed so a note that opens with a heading
// and a blank line still previews as words, not as a gap.
export function plainTextPreview(text: string, maxChars = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}
