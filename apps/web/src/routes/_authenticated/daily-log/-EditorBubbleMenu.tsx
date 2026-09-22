import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { TextSelection } from "@tiptap/pm/state";
import {
  Check,
  Code,
  LinkBreak,
  LinkSimple,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
  type Icon,
} from "@phosphor-icons/react";
import { Button } from "@/shadcn/ui/button";
import { Input } from "@/shadcn/ui/input";
import { cn } from "@/utils/tailwind";

// DEV_NOTE: a bare "example.com" is what people paste; without a scheme the browser would treat
// it as a path relative to the app.
function normalizeHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

interface MarkButton {
  label: string;
  icon: Icon;
  isActive: boolean;
  toggle: () => void;
}

// DEV_NOTE: the formatting toolbar only exists while text is selected — Notion's model, where the
// page is just the writing until you reach for something. It stays hidden for node selections (a
// block picked up by the drag handle) and inside code blocks, where marks don't apply.
export default function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const href: unknown = current.getAttributes("link").href;
      return {
        bold: current.isActive("bold"),
        italic: current.isActive("italic"),
        underline: current.isActive("underline"),
        strike: current.isActive("strike"),
        code: current.isActive("code"),
        link: current.isActive("link"),
        href: typeof href === "string" ? href : "",
      };
    },
  });

  const marks: MarkButton[] = [
    {
      label: "Bold",
      icon: TextB,
      isActive: state.bold,
      toggle: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      icon: TextItalic,
      isActive: state.italic,
      toggle: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "Underline",
      icon: TextUnderline,
      isActive: state.underline,
      toggle: () => editor.chain().focus().toggleUnderline().run(),
    },
    {
      label: "Strikethrough",
      icon: TextStrikethrough,
      isActive: state.strike,
      toggle: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      label: "Inline code",
      icon: Code,
      isActive: state.code,
      toggle: () => editor.chain().focus().toggleCode().run(),
    },
  ];

  function applyLink() {
    const href = normalizeHref(linkDraft);
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href) chain.setLink({ href }).run();
    else chain.unsetLink().run();
    setIsEditingLink(false);
  }

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8, flip: true, shift: { padding: 8 } }}
      shouldShow={({ editor: current, element, view, state: editorState, from, to }) => {
        const { selection } = editorState;
        if (!(selection instanceof TextSelection) || selection.empty) return false;
        if (!editorState.doc.textBetween(from, to).length) return false;
        if (current.isActive("codeBlock") || !current.isEditable) return false;
        // DEV_NOTE: the link input takes focus away from the editor — without this the menu would
        // close the moment someone clicks into it.
        return view.hasFocus() || element.contains(document.activeElement);
      }}
      className="z-50 flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {isEditingLink ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <Input
            autoFocus
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setIsEditingLink(false);
                editor.commands.focus();
              }
            }}
            placeholder="Paste a link"
            aria-label="Link address"
            className="h-8 w-56"
          />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Apply link">
            <Check className="size-4" weight="bold" />
          </Button>
        </form>
      ) : (
        <>
          {marks.map((mark) => {
            const MarkIcon = mark.icon;
            return (
              <Button
                key={mark.label}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={mark.label}
                aria-pressed={mark.isActive}
                onClick={mark.toggle}
                className={cn(mark.isActive && "bg-muted text-foreground")}
              >
                <MarkIcon className="size-4" weight={mark.isActive ? "bold" : "regular"} />
              </Button>
            );
          })}
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={state.link ? "Edit link" : "Add link"}
            aria-pressed={state.link}
            onClick={() => {
              setLinkDraft(state.href);
              setIsEditingLink(true);
            }}
            className={cn(state.link && "bg-muted text-foreground")}
          >
            <LinkSimple className="size-4" weight={state.link ? "bold" : "regular"} />
          </Button>
          {state.link ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove link"
              onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
            >
              <LinkBreak className="size-4" />
            </Button>
          ) : null}
        </>
      )}
    </BubbleMenu>
  );
}
