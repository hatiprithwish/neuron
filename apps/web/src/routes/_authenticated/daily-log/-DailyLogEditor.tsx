import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Typography from "@tiptap/extension-typography";
import { DotsThree, Trash } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@/shadcn/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shadcn/ui/dropdown-menu";
import { cn } from "@/utils/tailwind";
import { useDeleteDailyLog, useUpsertDailyLog } from "./-data";
import { SlashCommand } from "./-SlashCommand";
import EditorBubbleMenu from "./-EditorBubbleMenu";
import EditorDragHandle from "./-EditorDragHandle";

// DEV_NOTE: long enough that a person mid-sentence isn't saving on every keystroke, short enough
// that closing the tab a second after the last word loses nothing (and the unmount flush below
// covers navigating away inside the app).
const SAVE_DEBOUNCE_MS = 800;

// DEV_NOTE: the document's typography lives here as Tailwind arbitrary variants on the
// ProseMirror root — CLAUDE.md's Tailwind-only rule, and no typography plugin to install. Spacing is
// Notion-tight: blocks sit close, headings get room above them.
const PROSE_CLASSES = cn(
  "min-h-[50vh] text-base leading-7 text-foreground outline-none",
  "[&>*:first-child]:mt-0 [&_p]:my-1",
  "[&_h1]:mt-8 [&_h1]:mb-2 [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:leading-tight [&_h1]:font-semibold",
  "[&_h2]:mt-6 [&_h2]:mb-1.5 [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:leading-snug [&_h2]:font-semibold",
  "[&_h3]:mt-5 [&_h3]:mb-1 [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5 [&_li>p]:my-0",
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0.5",
  "[&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:items-start [&_li[data-type=taskItem]]:gap-2",
  "[&_li[data-type=taskItem]>label]:mt-1 [&_li[data-type=taskItem]>label]:shrink-0 [&_li[data-type=taskItem]>label]:select-none",
  "[&_li[data-type=taskItem]>div]:min-w-0 [&_li[data-type=taskItem]>div]:flex-1",
  "[&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:cursor-pointer [&_input[type=checkbox]]:accent-primary",
  "[&_li[data-checked=true]>div]:text-muted-foreground [&_li[data-checked=true]>div]:line-through",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-foreground/30 [&_blockquote]:pl-4",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-6 [&_hr]:border-border [&_hr.ProseMirror-selectednode]:border-primary",
  "[&_a]:cursor-pointer [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
  // Placeholder extension — the hint sits in the empty block the cursor is in.
  "[&_.is-empty]:before:pointer-events-none [&_.is-empty]:before:float-left [&_.is-empty]:before:h-0",
  "[&_.is-empty]:before:text-muted-foreground/70 [&_.is-empty]:before:content-[attr(data-placeholder)]",
);

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error" | "too-long";

const STATUS_LABELS: Record<SaveStatus, string> = {
  idle: "",
  unsaved: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
  "too-long": "Too long to save",
};

interface DailyLogEditorProps {
  localDate: string;
  initialContent: Schemas.TiptapDoc | null;
}

// DEV_NOTE: useEditor + <EditorContent />, not the composable <Tiptap> API — the editor, its menus
// and its autosave all live in this one component, which is the case the hook API is meant for.
// The document is uncontrolled after the first render: the query cache only seeds it, so a save
// landing in the cache can never move the cursor or drop what's being typed.
export default function DailyLogEditor({ localDate, initialContent }: DailyLogEditorProps) {
  const upsert = useUpsertDailyLog(localDate);
  const deleteLog = useDeleteDailyLog();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDocRef = useRef<JSONContent | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // DEV_NOTE: tracked here rather than read off the query — a save that emptied the editor, or a
  // delete, changes whether a row exists, and this component is the one that just did it.
  const [hasSavedLog, setHasSavedLog] = useState(initialContent !== null);

  // DEV_NOTE: straight into writing on a pointer device; on touch, a keyboard sliding up the
  // moment the page opens would cover the day before it's been read.
  const [shouldAutofocus] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches,
  );

  function save() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const doc = pendingDocRef.current;
    if (!doc) return;
    pendingDocRef.current = null;

    const parsed = Schemas.ZTiptapDoc.safeParse(doc);
    if (!parsed.success) {
      setStatus("too-long");
      return;
    }

    setStatus("saving");
    upsert.mutate(
      { contentJson: parsed.data },
      {
        onSuccess: (response) => {
          setHasSavedLog(Boolean(response.dailyLog));
          setStatus((current) => (current === "saving" ? "saved" : current));
        },
        onError: () => setStatus("error"),
      },
    );
  }
  // DEV_NOTE: save() runs from the editor's onUpdate timer and from the unmount cleanup, both of
  // which outlive the render that created them — they call through this ref, kept current after
  // every render.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const editor = useEditor({
    // DEV_NOTE: TanStack Start renders on the server first; rendering the editor there would
    // mismatch on hydration, so it's created on the client only (Tiptap's SSR guidance).
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Typography,
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === "heading") return `Heading ${String(node.attrs.level)}`;
          return "Write something, or type '/' for blocks…";
        },
      }),
      SlashCommand,
    ],
    content: initialContent ?? "",
    autofocus: shouldAutofocus ? "end" : false,
    editorProps: {
      attributes: {
        class: PROSE_CLASSES,
        "aria-label": "Daily log",
      },
    },
    onUpdate: ({ editor: current }) => {
      pendingDocRef.current = current.getJSON();
      setStatus("unsaved");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveRef.current(), SAVE_DEBOUNCE_MS);
    },
  });

  // DEV_NOTE: navigating to another day (or away) inside the app mid-debounce still saves — the
  // pending document is flushed on unmount, and the mutation outlives the component.
  useEffect(() => {
    return () => saveRef.current();
  }, []);

  // DEV_NOTE: a hard close/reload can't be flushed reliably (a fetch fired from unload may be
  // dropped), so the browser's own "leave site?" prompt covers the last few hundred milliseconds.
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingDocRef.current || status === "saving") event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [status]);

  // DEV_NOTE: a pending autosave is dropped first — otherwise it would fire after the delete and
  // write the day straight back. window.confirm because a whole day's writing has no undo in the app.
  function handleDelete() {
    if (
      !window.confirm("Delete this day's log? Everything written for this day will be removed.")
    ) {
      return;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingDocRef.current = null;

    deleteLog.mutate(localDate, {
      onSuccess: () => {
        editor?.commands.clearContent(false);
        upsert.reset();
        setHasSavedLog(false);
        setStatus("idle");
      },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-8 items-center justify-end gap-2">
        <p
          aria-live="polite"
          className={cn(
            "text-xs text-muted-foreground",
            (status === "error" || status === "too-long") && "text-destructive",
          )}
        >
          {STATUS_LABELS[status]}
        </p>
        {hasSavedLog ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Log options">
                <DotsThree className="size-4" weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                disabled={deleteLog.isPending}
                onSelect={handleDelete}
              >
                <Trash className="size-4" />
                Delete log
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {editor ? (
        // DEV_NOTE: pl-8 is the gutter the drag handle sits in — the plugin appends it next to the
        // ProseMirror root and places it to the left of the hovered block.
        <div className="relative pl-8">
          <EditorDragHandle editor={editor} />
          <EditorBubbleMenu editor={editor} />
          <EditorContent editor={editor} className="relative" />
        </div>
      ) : (
        <div className="min-h-[50vh] pl-8" aria-busy />
      )}
    </div>
  );
}
