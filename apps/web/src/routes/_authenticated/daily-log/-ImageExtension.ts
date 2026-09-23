import Image from "@tiptap/extension-image";
import * as Schemas from "@app/schemas";

// DEV_NOTE: the stock Image node plus one non-rendered attribute. An upload shows its image
// immediately from a local blob URL, and `uploadId` is how the finished upload finds that exact
// node again to swap in the real URL (or removes it if the upload failed). It never reaches the
// saved document: `rendered: false` keeps it out of the HTML, and -uploadImage.ts clears it on
// success, so a reload has no trace of it.
export const DailyLogImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadId: {
        default: null,
        rendered: false,
      },
    };
  },
}).configure({
  // DEV_NOTE: block images, not inline — a photo in a journal is its own paragraph, and inline
  // would let it land mid-sentence where the resize handles have nowhere to go.
  inline: false,
  // DEV_NOTE: base64 stays off. Every image is an uploaded object with a URL; allowing data URIs
  // would let a paste smuggle megabytes into the document JSON and past its size cap.
  allowBase64: false,
  resize: {
    enabled: true,
    minWidth: 96,
    minHeight: 96,
    alwaysPreserveAspectRatio: true,
  },
  HTMLAttributes: {
    class: "rounded-md",
  },
});

// DEV_NOTE: the width an image is dropped in at — the editor column, not the stored derivative's
// 1600px. Stored dimensions still decide the aspect ratio, so the space is reserved correctly
// before the bytes arrive and the page doesn't jump.
const DEFAULT_DISPLAY_WIDTH = 720;

export function displayDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; height: number } | null {
  if (!width || !height) return null;

  const scale = Math.min(1, DEFAULT_DISPLAY_WIDTH / width);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function validateImageFile(
  file: File,
): { isValid: true } | { isValid: false; message: string } {
  if (!Schemas.ZUploadType.safeParse(file.type).success) {
    return { isValid: false, message: `${file.name} isn't an image type we can store` };
  }
  if (file.size > Schemas.MAX_UPLOAD_BYTES) {
    const limitMb = Math.round(Schemas.MAX_UPLOAD_BYTES / (1024 * 1024));
    return { isValid: false, message: `${file.name} is over ${limitMb}MB` };
  }
  return { isValid: true };
}
