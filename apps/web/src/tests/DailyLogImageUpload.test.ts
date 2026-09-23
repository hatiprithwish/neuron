import { describe, it, expect } from "vitest";
import {
  displayDimensions,
  validateImageFile,
} from "@/routes/_authenticated/daily-log/-ImageExtension";
import { mediaPublicIdFromUrl, MAX_UPLOAD_BYTES } from "@app/schemas";

function makeFile(type: string, size: number, name = "photo.png"): File {
  const file = new File(["x"], name, { type });
  // File size is derived from its contents, so it's overridden here rather than allocating 10MB.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("validateImageFile", () => {
  it("accepts the types the server stores", () => {
    expect(validateImageFile(makeFile("image/png", 1024)).isValid).toBe(true);
    expect(validateImageFile(makeFile("image/heic", 1024)).isValid).toBe(true);
  });

  // DEV_NOTE: SVG is refused on both sides — it can carry script and would be served from the
  // API's own origin.
  it("refuses types the server would reject, before any upload happens", () => {
    const result = validateImageFile(makeFile("image/svg+xml", 1024, "logo.svg"));
    expect(result).toEqual({
      isValid: false,
      message: "logo.svg isn't an image type we can store",
    });
  });

  it("refuses files over the size cap", () => {
    const result = validateImageFile(makeFile("image/jpeg", MAX_UPLOAD_BYTES + 1, "big.jpg"));
    expect(result).toEqual({ isValid: false, message: "big.jpg is over 10MB" });
    expect(validateImageFile(makeFile("image/jpeg", MAX_UPLOAD_BYTES)).isValid).toBe(true);
  });
});

describe("displayDimensions", () => {
  it("scales a wide image down to the editor column, keeping its ratio", () => {
    expect(displayDimensions(1600, 1200)).toEqual({ width: 720, height: 540 });
  });

  it("leaves an image smaller than the column at its own size", () => {
    expect(displayDimensions(400, 300)).toEqual({ width: 400, height: 300 });
  });

  it("returns null when the server couldn't read dimensions", () => {
    expect(displayDimensions(null, null)).toBeNull();
    expect(displayDimensions(1600, null)).toBeNull();
  });
});

describe("mediaPublicIdFromUrl", () => {
  it("maps a stored URL back to the row the cleanup deletes", () => {
    expect(mediaPublicIdFromUrl("https://api.example.com/media/med_abc123")).toBe("med_abc123");
  });

  it("ignores URLs that aren't ours, including the upload placeholder", () => {
    expect(mediaPublicIdFromUrl("blob:http://localhost:3000/9f1c")).toBeNull();
    expect(mediaPublicIdFromUrl("https://images.example.net/cat.png")).toBeNull();
  });
});
