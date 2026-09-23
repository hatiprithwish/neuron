import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
  CheckSquare,
  ImageSquare,
  Code,
  ListBullets,
  ListNumbers,
  Minus,
  Quotes,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextT,
} from "@phosphor-icons/react";
import SlashMenu, { type SlashItem, type SlashMenuHandle, type SlashMenuProps } from "./-SlashMenu";
import { openImagePicker } from "./-uploadImage";

// DEV_NOTE: every item first deletes the "/query" the user typed, then turns the current block
// into the chosen one — the same thing Notion's slash menu does, so the trigger text never lingers.
export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    description: "Plain writing",
    keywords: ["paragraph", "p", "plain"],
    icon: TextT,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    description: "Big section heading",
    keywords: ["h1", "title", "heading"],
    icon: TextHOne,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    keywords: ["h2", "subtitle", "heading"],
    icon: TextHTwo,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    keywords: ["h3", "heading"],
    icon: TextHThree,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    description: "A simple list",
    keywords: ["ul", "bullet", "unordered", "list"],
    icon: ListBullets,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    description: "A list in order",
    keywords: ["ol", "numbered", "ordered", "list"],
    icon: ListNumbers,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    description: "Things to tick off",
    keywords: ["todo", "task", "checkbox", "check"],
    icon: CheckSquare,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Set a line apart",
    keywords: ["blockquote", "quote", "citation"],
    icon: Quotes,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setBlockquote().run(),
  },
  {
    title: "Code",
    description: "A block of code",
    keywords: ["codeblock", "pre", "snippet"],
    icon: Code,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    title: "Image",
    description: "Upload a picture",
    keywords: ["image", "picture", "photo", "upload", "img"],
    icon: ImageSquare,
    // DEV_NOTE: the range goes first — the file dialog is modal, and leaving "/image" in the
    // document behind it looks like the command didn't take.
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      openImagePicker(editor);
    },
  },
  {
    title: "Divider",
    description: "A line between sections",
    keywords: ["hr", "rule", "separator", "line"],
    icon: Minus,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SLASH_ITEMS;

  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      item.keywords.some((keyword) => keyword.startsWith(needle)),
  );
}

const SlashCommandPluginKey = new PluginKey("slashCommand");

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: SlashCommandPluginKey,
        char: "/",
        // DEV_NOTE: never inside a code block — a "/" there is a path or a comment, not a command.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let component: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null = null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenu, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              // DEV_NOTE: managed positioning — the plugin mounts the element, anchors it to the
              // cursor and keeps it there on scroll/resize. unmount() in onExit tears that down.
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: props.command });
            },
            // DEV_NOTE: Escape is handled by the plugin itself (it always exits the suggestion),
            // so only navigation keys are forwarded to the menu.
            onKeyDown: (props) => {
              if (props.event.key === "Escape") return false;
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              unmount?.();
              unmount = null;
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});
