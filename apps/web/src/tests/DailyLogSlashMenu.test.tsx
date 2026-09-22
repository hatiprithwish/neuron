import type { RefObject } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, it, expect, vi } from "vitest";
import SlashMenu, { type SlashMenuHandle } from "@/routes/_authenticated/daily-log/-SlashMenu";
import { SLASH_ITEMS, filterSlashItems } from "@/routes/_authenticated/daily-log/-SlashCommand";

// DEV_NOTE: jsdom doesn't implement scrollIntoView, which the menu calls to keep the highlighted
// block visible while arrowing through a long list.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeRef(): RefObject<SlashMenuHandle | null> {
  return { current: null };
}

function press(ref: RefObject<SlashMenuHandle | null>, key: string): boolean {
  let handled = false;
  act(() => {
    handled = ref.current?.onKeyDown(new KeyboardEvent("keydown", { key })) ?? false;
  });
  return handled;
}

describe("filterSlashItems", () => {
  it("returns every block for an empty query", () => {
    expect(filterSlashItems("")).toEqual(SLASH_ITEMS);
    expect(filterSlashItems("   ")).toEqual(SLASH_ITEMS);
  });

  it("matches on title and on keyword prefixes", () => {
    expect(filterSlashItems("h2").map((item) => item.title)).toEqual(["Heading 2"]);
    expect(filterSlashItems("todo").map((item) => item.title)).toEqual(["To-do list"]);
    expect(filterSlashItems("QUOTE").map((item) => item.title)).toEqual(["Quote"]);
    expect(filterSlashItems("list").map((item) => item.title)).toEqual([
      "Bulleted list",
      "Numbered list",
      "To-do list",
    ]);
  });

  it("returns nothing for a query no block matches", () => {
    expect(filterSlashItems("zzz")).toEqual([]);
  });
});

describe("SlashMenu", () => {
  it("moves the highlight with the arrow keys and runs the highlighted block on Enter", () => {
    const command = vi.fn();
    const ref = makeRef();
    render(<SlashMenu ref={ref} items={SLASH_ITEMS} command={command} />);

    expect(screen.getByRole("option", { name: /^Text/ })).toHaveAttribute("aria-selected", "true");

    expect(press(ref, "ArrowDown")).toBe(true);
    expect(screen.getByRole("option", { name: /Heading 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Wraps from the top to the last block.
    press(ref, "ArrowUp");
    press(ref, "ArrowUp");
    expect(screen.getByRole("option", { name: /Divider/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    expect(press(ref, "Enter")).toBe(true);
    expect(command).toHaveBeenCalledWith(SLASH_ITEMS[SLASH_ITEMS.length - 1]);
  });

  it("snaps the highlight back to the first match when the list is re-filtered", () => {
    const command = vi.fn();
    const ref = makeRef();
    const { rerender } = render(<SlashMenu ref={ref} items={SLASH_ITEMS} command={command} />);

    press(ref, "ArrowDown");
    press(ref, "ArrowDown");
    rerender(<SlashMenu ref={ref} items={filterSlashItems("list")} command={command} />);

    expect(screen.getByRole("option", { name: /Bulleted list/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("runs a block on mouse down without leaving the editor", () => {
    const command = vi.fn();
    render(<SlashMenu items={SLASH_ITEMS} command={command} />);

    fireEvent.mouseDown(screen.getByRole("option", { name: /Quote/ }));
    expect(command).toHaveBeenCalledWith(SLASH_ITEMS.find((item) => item.title === "Quote"));
  });

  it("shows an empty state and lets keys fall through to the editor when nothing matches", () => {
    const ref = makeRef();
    render(<SlashMenu ref={ref} items={[]} command={vi.fn()} />);

    expect(screen.getByText("No matching blocks")).toBeInTheDocument();
    expect(press(ref, "Enter")).toBe(false);
  });
});
