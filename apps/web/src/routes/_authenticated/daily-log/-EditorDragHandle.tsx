import type { Editor } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { DotsSixVertical } from "@phosphor-icons/react";

// DEV_NOTE: the ⋮⋮ grip that appears beside whichever block the pointer is over — pick a block up
// and drop it somewhere else, Notion-style. The plugin positions it (left of the block) and shows or
// hides it; it only reacts to a mouse, so touch devices never see it and keep plain scrolling.
// `nested` lets a single list item or to-do be moved on its own, not just the whole list.
export default function EditorDragHandle({ editor }: { editor: Editor }) {
  return (
    <DragHandle editor={editor} nested className="pr-1.5">
      <div
        aria-hidden
        className="flex h-6 w-5 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
      >
        <DotsSixVertical className="size-4" weight="bold" />
      </div>
    </DragHandle>
  );
}
