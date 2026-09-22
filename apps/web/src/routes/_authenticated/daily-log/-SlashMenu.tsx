import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Editor, Range } from "@tiptap/core";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/utils/tailwind";

export interface SlashItem {
  title: string;
  description: string;
  keywords: string[];
  icon: Icon;
  run: (editor: Editor, range: Range) => void;
}

export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  ref?: Ref<SlashMenuHandle>;
}

// DEV_NOTE: rendered by the suggestion plugin through ReactRenderer + props.mount (see
// -SlashCommand.tsx), which owns positioning with Floating UI — so this is a plain panel styled like
// shadcn's popover, not a Radix Popover, which would try to position itself a second time. Keys
// arrive via the imperative handle because focus never leaves the editor while the menu is open.
export default function SlashMenu({ items, command, ref }: SlashMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previousItems, setPreviousItems] = useState(items);
  const listRef = useRef<HTMLDivElement>(null);

  // DEV_NOTE: every keystroke after "/" re-filters the list; the highlight snaps back to the first
  // match rather than pointing at whatever now sits at the old index.
  if (items !== previousItems) {
    setPreviousItems(items);
    setSelectedIndex(0);
  }

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (items.length === 0) return false;

        if (event.key === "ArrowDown") {
          setSelectedIndex((index) => (index + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((index) => (index - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selectedIndex, command],
  );

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Insert block"
      className="z-50 max-h-80 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching blocks</p>
      ) : (
        <>
          <p className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-widest text-muted-foreground uppercase">
            Blocks
          </p>
          {items.map((item, index) => {
            const ItemIcon = item.icon;
            return (
              <button
                key={item.title}
                type="button"
                role="option"
                data-index={index}
                aria-selected={index === selectedIndex}
                // DEV_NOTE: mousedown, not click — a click would first blur the editor and the
                // suggestion would close before the command could run.
                onMouseDown={(event) => {
                  event.preventDefault();
                  command(item);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left",
                  index === selectedIndex && "bg-accent text-accent-foreground",
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <ItemIcon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
