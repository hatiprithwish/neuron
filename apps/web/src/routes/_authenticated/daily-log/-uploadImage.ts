import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { displayDimensions, validateImageFile } from "./-ImageExtension";

// DEV_NOTE: the slash menu's Image item only gets (editor, range) — it has no way to reach the
// file input or the upload mutation, both of which live in the editor component. The component
// registers its picker here on mount, keyed by editor instance, and the menu item looks it up.
const pickers = new WeakMap<Editor, () => void>();

export function registerImagePicker(editor: Editor, pick: () => void): () => void {
  pickers.set(editor, pick);
  return () => pickers.delete(editor);
}

export function openImagePicker(editor: Editor): void {
  pickers.get(editor)?.();
}

function findUploadPos(editor: Editor, uploadId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "image" && node.attrs.uploadId === uploadId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

type UploadFn = (file: File) => Promise<Schemas.UploadMediaApiResponse>;

// DEV_NOTE: the image appears the instant it's chosen, from a local blob URL, and its src is
// swapped for the stored one when the upload lands — waiting on the network before anything
// appears makes dropping a photo feel broken. A failed upload takes its placeholder with it, so
// the document is never saved pointing at a blob URL that dies with the tab.
export async function insertImageUpload(params: {
  editor: Editor;
  file: File;
  upload: UploadFn;
  position?: number;
}): Promise<void> {
  const { editor, file, upload, position } = params;

  const validation = validateImageFile(file);
  if (!validation.isValid) {
    toast.error(validation.message);
    return;
  }

  const uploadId = crypto.randomUUID();
  const previewUrl = URL.createObjectURL(file);

  const insertAt = position ?? editor.state.selection.from;
  editor
    .chain()
    .insertContentAt(insertAt, {
      type: "image",
      attrs: { src: previewUrl, alt: file.name, uploadId },
    })
    .run();

  try {
    const response = await upload(file);
    const media = response.media;
    if (!media) throw new Error(response.message ?? "Upload failed");

    const pos = findUploadPos(editor, uploadId);
    if (pos === null) {
      // DEV_NOTE: the placeholder was deleted while the upload was in flight (undo, or the user
      // removing it) — the intent was clearly "not this image", so nothing is re-inserted.
      return;
    }

    const size = displayDimensions(media.width, media.height);
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, {
          ...tr.doc.nodeAt(pos)?.attrs,
          src: media.url,
          uploadId: null,
          ...(size ?? {}),
        });
        return true;
      })
      .run();
  } catch {
    const pos = findUploadPos(editor, uploadId);
    if (pos !== null) {
      editor
        .chain()
        .command(({ tr }) => {
          const node = tr.doc.nodeAt(pos);
          if (node) tr.delete(pos, pos + node.nodeSize);
          return true;
        })
        .run();
    }
    // DEV_NOTE: the mutation's own onError already toasts; this catch exists to take the
    // placeholder back out, not to report again.
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

export async function insertImageUploads(params: {
  editor: Editor;
  files: File[];
  upload: UploadFn;
  position?: number;
}): Promise<void> {
  // DEV_NOTE: sequential, not Promise.all — each insert reads the current selection/position, and
  // parallel uploads would race over where the next image lands.
  for (const file of params.files) {
    await insertImageUpload({
      editor: params.editor,
      file,
      upload: params.upload,
      position: params.position,
    });
  }
}
